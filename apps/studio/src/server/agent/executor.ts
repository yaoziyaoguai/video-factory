import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ArtifactDraftStream } from "./artifact-drafts.js";
import { AgentError, AgentToolError } from "./errors.js";
import type { AgentDatabase } from "./db.js";
import type { EventHub } from "./event-log.js";
import type { PiModelSelection, PiRuntimeHost, ConversationSession } from "./pi-runtime.js";
import type { ActiveRequestContext, CrashPointHook } from "./pi-tools.js";
import type {
  ContextStatus, Target, ModelBinding, ModelEntry, FeedbackNote,
} from "../../shared/agent/generated/contracts.js";
import {
  claimNextRequest, emptyReferences, finalizeRequestMessages, getConversation, insertMessage,
  markRequestTerminal, nextSeq, touchConversation, saveAssistantMessage, type RequestRow,
} from "./conversation-store.js";
import { listArtifactRows, getProposalRow, rowToProposal } from "./artifact-store.js";
import { listWorkRows, relatedWorkFeedback, workProjection } from "./creative-work.js";
import { captureStockConfigs } from "./free-service-settings.js";
import { listMaterialBatches } from "./material-store.js";
import { StockClient } from "./stock-providers.js";
import { contextProductionIndex } from "./production-index.js";
import type { AgentClock } from "./util.js";

// 每会话一个 runner：串行领取队列（单前台写入者），持有一个 Pi 会话。
// steer/stop 都先在事务里验证再作用到内存状态；current 在 prompt 返回后同步清空，
// 防止“旧 steer 留给下个话题”（SDK 的 steer 在非流式时会排入下一次回合）。
// 模型按每条请求的冻结绑定解析：编辑配置不影响已接收请求，缺版本如实失败。

export interface ExecutorOptions {
  db: AgentDatabase;
  clock: AgentClock;
  hub: EventHub;
  host: PiRuntimeHost;
  /** 每回合 context 构造时读取当前媒体目录；不提供时媒体不出现在回合上下文。 */
  mediaModels?: () => ModelEntry[];
  productionAvailable?: boolean;
  toolFactory: (holder: { current: ActiveRequestContext | null }) => ToolDefinition[];
  limits?: { turnMs: number; maxToolCalls: number };
  /** 崩溃窗口注入（SIGKILL 测试）；after-claim / before-finalize 等点位见 runTurn。 */
  crashPoint?: CrashPointHook;
}

type AbortReason = "timeout" | "tool_limit" | "stopped_pending" | null;

interface CurrentTurn {
  requestId: string;
  epoch: number;
  abortReason: AbortReason;
}

const TOOL_NAMES = [
  "read_skill_file", "read_artifact", "deliver_artifacts", "prepare_production",
  "read_proposal", "read_run", "list_production",
  "search_materials", "read_material_batch", "read_trends", "import_material",
  "start_work", "read_work", "confirm_stage", "record_work_feedback",
] as const;

export class ConversationRunner {
  current: CurrentTurn | null = null;
  private sessionHandle: ConversationSession | null = null;
  private loopPromise: Promise<void> | null = null;
  private subscribed = false;
  private closing = false;
  private kickPending = false;
  private readonly steering = new Set<Promise<unknown>>();

  constructor(
    readonly conversationId: string,
    private readonly options: ExecutorOptions,
    private readonly holder: { current: ActiveRequestContext | null },
  ) {}

  get session(): AgentSession | null {
    return this.sessionHandle?.session ?? null;
  }

  kick(): void {
    if (this.closing) return;
    if (this.loopPromise) { this.kickPending = true; return; }
    this.loopPromise = this.loop()
      .catch(error => {
        process.emitWarning(`agent runner ${this.conversationId} 异常退出: ${String(error)}`);
      })
      .finally(() => {
        this.loopPromise = null;
        if (this.kickPending && !this.closing) { this.kickPending = false; this.kick(); }
      });
  }

  private async loop(): Promise<void> {
    while (!this.closing) {
      const claimed = this.options.db.transaction(() =>
        claimNextRequest(this.options.db, this.options.clock(), this.conversationId))();
      if (!claimed) return;
      // 崩溃窗口：领取已提交、检查点尚未写入。
      this.options.crashPoint?.("after-claim");
      await this.runTurn(claimed.row, claimed.epoch);
    }
  }

  private async ensureSession(piSessionId: string, recoveryCheckpoint: string | undefined, selection: PiModelSelection): Promise<AgentSession> {
    if (this.sessionHandle) {
      // 已有会话空闲时切换到本请求的冻结模型与推理档位；同一模型也要应用本请求档位。
      await this.options.host.applySessionModel(this.sessionHandle.session, selection);
      return this.sessionHandle.session;
    }
    const handle = await this.options.host.openConversationSession(
      this.conversationId,
      piSessionId,
      this.options.toolFactory(this.holder).map(tool => ({
        ...tool,
        execute: async (...args) => {
          const current = this.current;
          if (!current || current.abortReason || !this.holder.current) throw new AgentToolError("REQUEST_NOT_RUNNING", "本回合已结束。");
          const count = this.toolCallCounts.get(current.requestId) ?? 0;
          if (count >= (this.options.limits?.maxToolCalls ?? 32)) {
            this.endEarly("tool_limit");
            throw new AgentToolError("REQUEST_NOT_RUNNING", "本回合达到工具调用上限。");
          }
          this.toolCallCounts.set(current.requestId, count + 1);
          const result = await tool.execute(...args);
          this.options.hub.notifyCommitted(this.conversationId);
          return result;
        },
      })),
      [...TOOL_NAMES],
      selection,
      recoveryCheckpoint,
      () => this.currentContext(),
    );
    if (!this.subscribed) {
      handle.session.subscribe(event => this.onSessionEvent(event));
      this.subscribed = true;
    }
    this.sessionHandle = handle;
    return handle.session;
  }

  private onSessionEvent(event: AgentSessionEvent): void {
    const current = this.current;
    if (!current) return;
    const { requestId } = current;
    // steering 的真实来源只在 Pi 原生接收这条用户消息时绑定；未被接收的 steer 不冒用。
    if (event.type === "message_start" && event.message.role === "user" && this.holder.current) {
      const text = userMessageText(event.message);
      const index = this.pendingSteerSources.findIndex(entry => entry.text === text);
      if (index !== -1) {
        const [entry] = this.pendingSteerSources.splice(index, 1);
        this.holder.current.actionSourceMessageId = entry!.messageId;
      }
    }
    if (!current.abortReason) this.draftStream?.accept(event);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && !current.abortReason) {
      this.options.hub.emitDelta(this.conversationId, {
        requestId, messageId: `msg-${requestId.slice(4)}`,
        sequence: this.deltaSequences.get(requestId) ?? 0, text: event.assistantMessageEvent.delta,
      });
      this.deltaSequences.set(requestId, (this.deltaSequences.get(requestId) ?? 0) + 1);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      this.assistantEnd = { text: event.message.content.filter(block => block.type === "text").map(block => block.text).join(""),
        stopReason: event.message.stopReason, ...(event.message.errorMessage !== undefined ? { errorMessage: event.message.errorMessage } : {}) };
    }
    if ((event.type === "compaction_start" || event.type === "compaction_end") && event.reason !== "manual") {
      const status: ContextStatus = event.type === "compaction_start"
        ? { requestId, sequence: this.contextSequence++, phase: "compacting", reason: event.reason, willRetry: null }
        : { requestId, sequence: this.contextSequence++, phase: event.aborted ? "cancelled" : event.result ? "compacted" : "failed",
          reason: event.reason, willRetry: event.willRetry };
      this.options.hub.emitContextStatus(this.conversationId, status);
      if (event.type === "compaction_end") {
        this.compactionFailed = status.phase === "failed";
        // 只有 SDK 明确进入本请求的 compact-and-retry 时，才允许同参数提案回放。
        if (event.reason === "overflow" && event.willRetry && event.result && this.holder.current) {
          this.holder.current.nativeRecovery = true;
        }
        if (event.result) this.options.crashPoint?.("after-auto-compaction");
      }
    }
  }

  private draftStream: ArtifactDraftStream | null = null;
  private contextSequence = 0;
  private compactionFailed = false;
  private assistantEnd: { text: string; stopReason: string; errorMessage?: string } | null = null;
  private readonly deltaSequences = new Map<string, number>();
  private readonly toolCallCounts = new Map<string, number>();
  /** 已持久化、尚未被 Pi 原生接收的 steering 及其真实消息ID；接收/拒绝时按文本一一摘除。 */
  private readonly pendingSteerSources: { text: string; messageId: string }[] = [];

  private dropPendingSteer(messageId: string): void {
    const index = this.pendingSteerSources.findIndex(entry => entry.messageId === messageId);
    if (index !== -1) this.pendingSteerSources.splice(index, 1);
  }

  private endEarly(reason: Exclude<AbortReason, null>): void {
    if (!this.current || this.current.abortReason) return;
    this.current.abortReason = reason;
    this.draftStream?.close();
    this.holder.current = null;
    void this.abortSession();
  }

  private async abortSession(): Promise<void> {
    try {
      await this.session?.abort();
    } catch {
      // 回合结束路径在 finalize 兜底；abort 失败只影响能否提前中断。
    }
  }

  private currentContext(): string | null {
    const current = this.current;
    if (!current || current.abortReason || !this.holder.current) return null;
    const request = this.freshRequest(current.requestId);
    if (!request || request.state !== "running" || request.execution_epoch !== current.epoch || request.stop_requested) return null;
    const artifacts = listArtifactRows(this.options.db, this.conversationId, 50).map(row => ({
      artifactId: row.id, title: row.title, kind: row.kind, workId: row.work_id,
      headRevisionId: row.head_revision_id, headRevisionNumber: row.head_revision_number,
      digest: this.options.db.prepare("SELECT digest FROM artifact_revisions WHERE id = ?").get(row.head_revision_id ?? "") as { digest: string } | undefined,
    })).map(row => ({ ...row, digest: row.digest?.digest ?? null }));
    const target = request.target_json ? (JSON.parse(request.target_json) as Target) : null;
    const proposalIds = this.options.db.prepare(
      "SELECT DISTINCT proposal_id FROM tool_invocations WHERE request_id = ? AND proposal_id IS NOT NULL",
    ).all(request.id) as { proposal_id: string }[];
    // 引用以实际已消费的动作来源消息为准：steering 被原生接收后 context 读最新关联，
    // 不始终停留在最初 request.message_id。
    const message = this.options.db.prepare("SELECT references_json, target_json, feedback_json FROM messages WHERE id=?")
      .get(this.holder.current.actionSourceMessageId) as { references_json: string; target_json: string | null; feedback_json: string | null };
    const references = JSON.parse(message.references_json) as { proposalIds: string[]; artifacts: { artifactId: string }[] };
    const note = message.feedback_json ? JSON.parse(message.feedback_json) as FeedbackNote : null;
    const messageTarget = message.target_json ? JSON.parse(message.target_json) as Target : null;
    const feedbackTarget = note ? messageTarget : messageTarget ?? target;
    const confirmation = this.options.db.prepare("SELECT work_id FROM work_stage_confirmations WHERE source_kind='user_message' AND source_id=? LIMIT 1")
      .get(this.holder.current.actionSourceMessageId) as { work_id: string } | undefined;
    const explicitWorkId = note?.workId ?? feedbackTarget?.workId ?? confirmation?.work_id;
    const artifactIds = new Set(references.artifacts.map(item => item.artifactId));
    if (feedbackTarget) artifactIds.add(feedbackTarget.artifactId);
    const works = listWorkRows(this.options.db, this.conversationId, 50).map(row => workProjection(this.options.db, row));
    // 明确的意见归属优先；采用的独立稿没有 artifacts.work_id，按事项的真实来源识别。
    const referencedWorkIds = works.filter(work => explicitWorkId ? work.id === explicitWorkId :
      artifacts.some(artifact => artifact.workId === work.id && artifactIds.has(artifact.artifactId)) ||
      Object.values(work.stages).some(stage => [stage.draft, stage.approved].some(source =>
        source?.kind === "artifact_revision" && artifactIds.has(source.artifactId))))
      .map(work => work.id);
    for (const work of works.filter(item => referencedWorkIds.includes(item.id))) {
      for (const stage of Object.values(work.stages)) {
        for (const source of [stage.draft, stage.approved]) {
          if (source?.kind === "artifact_revision") artifactIds.add(source.artifactId);
        }
      }
    }
    const feedback = relatedWorkFeedback(this.options.db, this.conversationId,
      { workIds: referencedWorkIds, artifactIds: [...artifactIds] });
    const referencedProposals = references.proposalIds.map(id => getProposalRow(this.options.db, request.owner_id, id))
      .filter(row => row?.conversation_id === this.conversationId).map(row => rowToProposal(row!, this.options.db));
    const context = {
      conversationId: this.conversationId,
      requestId: request.id,
      actionSourceMessageId: this.holder.current.actionSourceMessageId,
      target,
      feedback,
      referencedProposals,
      works,
      referencedWorkIds,
      materialBatches: listMaterialBatches(this.options.db, this.conversationId, 100),
      // 当前实际可用（已启用且凭据齐全）的素材来源与各自支持的类型；未启用的来源不出现在能力里。
      materialServices: new StockClient(captureStockConfigs(this.options.db)).enabledServices(),
      mediaModels: this.options.mediaModels?.() ?? [],
      productionAvailable: this.options.productionAvailable ?? false,
      productionIndex: contextProductionIndex(this.options.db, this.conversationId),
      lockedArtifactIds: (this.options.db.prepare("SELECT DISTINCT artifact_id AS id FROM production_input_locks l JOIN production_runs r ON r.id=l.run_id WHERE r.conversation_id=?").all(this.conversationId) as { id: string }[]).map(row => row.id),
      artifacts,
      proposalsPreparedThisRequest: proposalIds.map(row => row.proposal_id),
      deliveryClosed: request.delivery_closed === 1,
    };
    return `[frame-current-state]${JSON.stringify(context)}\n这是本请求的当前业务状态，历史状态记录不代表当前事实；业务工具仍以数据库校验为准，模型输出不是制作授权。`;
  }

  private async runTurn(request: RequestRow, epoch: number): Promise<void> {
    const conversation = getConversation(this.options.db, request.owner_id, this.conversationId)!;
    this.current = { requestId: request.id, epoch, abortReason: null };
    this.assistantEnd = null; this.contextSequence = 0; this.compactionFailed = false;
    this.draftStream = new ArtifactDraftStream(request.id, draft => this.options.hub.emitDraft(this.conversationId, draft));
    this.holder.current = {
      actorId: request.owner_id,
      conversationId: this.conversationId,
      requestId: request.id,
      executionEpoch: epoch,
      target: request.target_json ? (JSON.parse(request.target_json) as Target) : null,
      actionSourceMessageId: request.message_id,
    };
    this.pendingSteerSources.length = 0;

    let outcome: "completed" | "stopped" | "failed" = "completed";
    let assistantText = "";
    let abortReason: AbortReason = null;
    // 仅接收本应用在解析冻结配置时明确构造的错误说明；供应商未知正文仍走通用失败出口。
    let failureNotice: string | null = null;
    try {
      // 领取后按请求冻结绑定解析模型与推理档位；绑定缺失或版本不存在都如实失败，不猜默认、不暗换当前配置。
      const binding = request.model_binding_json ? JSON.parse(request.model_binding_json) as ModelBinding : null;
      if (!binding) throw new Error("请求缺少冻结的模型绑定，不能执行；请重新发送消息。");
      const selection = await this.options.host.modelForBinding(binding);
      let recovery: string | undefined;
      if (conversation.pi_needs_recovery) {
        if (!conversation.pi_checkpoint_json) throw new Error("中断会话缺少安全续接位置，请新建会话；已有产物仍可读取。");
        // 归属核对：保存检查点的回合必须已终结（崩溃回合已被恢复流程标记 failed），
        // 且属于本会话；不匹配就不续接，原始记录保留。
        const saved = JSON.parse(conversation.pi_checkpoint_json) as { requestId?: unknown; conversationId?: unknown; sessionSeq?: unknown; executionEpoch?: unknown; queueSeq?: unknown };
        const owner = typeof saved.requestId === "string"
          ? this.options.db.prepare("SELECT conversation_id, state, execution_epoch, queue_seq FROM requests WHERE id = ?").get(saved.requestId) as { conversation_id: string; state: string; execution_epoch: number; queue_seq: number } | undefined
          : undefined;
        if (saved.conversationId !== this.conversationId || typeof saved.requestId !== "string"
          || !owner || owner.conversation_id !== this.conversationId || owner.state === "queued" || owner.state === "running"
          || saved.sessionSeq !== conversation.pi_session_id || saved.queueSeq !== owner.queue_seq || saved.executionEpoch !== owner.execution_epoch) {
          throw new Error("Pi 安全续接位置与中断回合不匹配；原始记录保留，请新建会话继续。");
        }
        recovery = conversation.pi_checkpoint_json;
      }
      const session = await this.ensureSession(conversation.pi_session_id, recovery, selection);
      const before = this.freshRequest(request.id);
      if (!before || before.state !== "running" || before.execution_epoch !== epoch || before.stop_requested) {
        outcome = "stopped";
      } else {
        // 正常对话交给 Pi 与各 I/O 自身的超时；不因工具等待超过两分钟取消整轮。
        // 显式注入的期限只供有意设置了回合预算的调用方使用。
        const timer = this.options.limits ? setTimeout(() => {
          if (this.current?.requestId === request.id && this.current.abortReason === null) {
            this.endEarly("timeout");
          }
        }, this.options.limits.turnMs) : undefined;
        try {
          const skill = before.skill_id ? (await this.options.host.listSkills()).find(item => item.id === before.skill_id) : null;
          if (before.skill_id && !skill) throw new Error("指定 Skill 已不可用");
          const ready = this.freshRequest(request.id);
          if (!ready || ready.state !== "running" || ready.execution_epoch !== epoch || ready.stop_requested) {
            outcome = "stopped";
          } else if (!this.current?.abortReason) {
            const prompt = ready.text;
            this.options.db.prepare("UPDATE conversations SET pi_checkpoint_json=?, pi_needs_recovery=0 WHERE id=?")
              .run(JSON.stringify({
                leafId: session.sessionManager.getLeafId(),
                requestId: request.id, executionEpoch: epoch, conversationId: this.conversationId,
                sessionSeq: conversation.pi_session_id, queueSeq: request.queue_seq,
              }), this.conversationId);
            await session.prompt(skill ? `/skill:${skill.name} ${prompt}` : prompt);
          }
          // 答案以 message_end 事件为准：压缩会重建 Pi 会话消息数组，
          // 事后切片取不到正确窗口；最后一条 assistant 消息胜出。
          const end = this.assistantEnd as { text: string; stopReason: string } | null;
          // 自身超限/停止引发的中止可能以 error stopReason 收尾，不算供应商失败；结局由下方 abortReason 归类。
          const selfAborted = this.current?.requestId === request.id && this.current.abortReason !== null;
          if (end) {
            assistantText = end.text;
            if (!selfAborted && (end.stopReason === "error" || end.stopReason === "length")) outcome = "failed";
          }
        } catch (error) {
          // prompt 抛出时上面的赋值未到达，这里按当前回合状态直接判定。
          const aborted = this.current?.requestId === request.id && this.current.abortReason !== null;
          if (!aborted) {
            outcome = "failed";
            process.emitWarning(`agent turn ${request.id} 失败: ${providerFailureSummary(error, this.assistantEnd)}`);
          }
        } finally {
          clearTimeout(timer);
        }
        abortReason = this.current?.requestId === request.id ? this.current.abortReason : null;
        const after = this.freshRequest(request.id);
        if (after?.stop_requested || abortReason === "stopped_pending") outcome = "stopped";
        else if (outcome !== "failed" && (abortReason === "timeout" || abortReason === "tool_limit")) {
          // 超限保存已发生事实并结束本回合；不自动新开回合补做。
          outcome = "completed";
        }
      }
    } catch (error) {
      outcome = "failed";
      if (error instanceof AgentError) failureNotice = error.message;
      process.emitWarning(`agent turn ${request.id} 初始化失败: ${String(error)}`);
    } finally {
      await Promise.allSettled([...this.steering]);
      this.session?.clearQueue();
      this.pendingSteerSources.length = 0;
      // 同步摘除当前回合上下文：之后的 steer 不可能落进本回合，工具调用立刻失去上下文。
      if (this.current?.requestId === request.id) this.current = null;
      this.holder.current = null;
      this.draftStream?.close(); this.draftStream = null;
      this.deltaSequences.delete(request.id);
      this.toolCallCounts.delete(request.id);

      // 崩溃窗口：回合事实已产生、finalize 事务尚未执行。
      this.options.crashPoint?.("before-finalize");
      this.finalizeTurn(request, epoch, outcome, assistantText, abortReason, failureNotice);
    }
  }

  private freshRequest(requestId: string): RequestRow | undefined {
    return this.options.db.prepare("SELECT * FROM requests WHERE id = ?").get(requestId) as RequestRow | undefined;
  }

  private finalizeTurn(
    request: RequestRow, epoch: number,
    outcome: "completed" | "stopped" | "failed", assistantText: string, abortReason: AbortReason,
    failureNotice: string | null = null,
  ): void {
    const now = this.options.clock();
    this.options.db.transaction(() => {
      const fresh = this.freshRequest(request.id);
      if (!fresh || fresh.state !== "running" || fresh.execution_epoch !== epoch) return;
      saveAssistantMessage(this.options.db, now, request, assistantText, outcome);
      markRequestTerminal(this.options.db, now, request, outcome);
      finalizeRequestMessages(this.options.db, now, request, outcome);
      const notice = failureNotice ?? noticeFor(outcome, abortReason, this.assistantEnd?.errorMessage) ?? (this.compactionFailed ? "上下文整理未完成；本回合已完成的答复和成果保留，可以继续讨论。" : null);
      if (notice) {
        insertMessage(this.options.db, now, {
          id: `ntc-${request.id.slice(4)}`, conversationId: this.conversationId, ownerId: request.owner_id,
          requestId: request.id, role: "system_notice", kind: "notice", state: "completed",
          text: notice, target: null, createdSeq: nextSeq(this.options.db, "messages", this.conversationId),
          references: emptyReferences(),
        });
      }
      touchConversation(this.options.db, now, this.conversationId);
    })();
    this.options.hub.notifyCommitted(this.conversationId);
  }

  // steer：只在会话确实流式时生效；否则返回未运行且不落任何消息。
  // 同步检查与调用之间没有 await，状态不会漂移。来源消息ID只在 Pi 原生 message_start 接收后绑定。
  async steerActive(requestId: string, text: string, persist: () => string): Promise<"applied" | "not_running"> {
    const session = this.session;
    if (!this.current || this.current.requestId !== requestId || this.current.abortReason || !session?.isStreaming) return "not_running";
    // 先持久化用户干预，再交给 Pi；等待队列接收完成后才允许启动下一条请求。
    const messageId = persist();
    const pending = session.steer(text);
    this.pendingSteerSources.push({ text, messageId });
    this.steering.add(pending);
    try {
      const disposition = await pending;
      if (disposition !== "queued" || !session.isStreaming || this.current?.requestId !== requestId) {
        this.dropPendingSteer(messageId);
        session.clearQueue();
        return "not_running";
      }
      return "applied";
    } finally { this.steering.delete(pending); }  }

  stopIfRunning(requestId: string): void {
    if (this.current?.requestId === requestId) {
      this.endEarly("stopped_pending");
    }
  }

  async reloadSkills(): Promise<void> {
    const session = this.session;
    if (!session) return;
    // 就地暂存原生会话当前的模型与档位：reload 会清除 applyOverrides，恢复后下一条请求
    // 再按自己的冻结绑定解析；不新增 runner 长期配置缓存，也不读当前默认。
    const selection = session.model ? { model: session.model, thinkingLevel: session.thinkingLevel } : null;
    await session.reload();
    if (selection) await this.options.host.applySessionModel(session, selection);
  }

  invalidateSession(): void {
    this.sessionHandle?.session.dispose();
    this.sessionHandle = null;
    this.subscribed = false;
  }

  async dispose(): Promise<void> {
    this.closing = true;
    if (this.current) this.endEarly("stopped_pending");
    await this.loopPromise;
    const session = this.session;
    this.sessionHandle = null;
    if (session) session.dispose();
  }
}

// 原生用户消息的文本形状（string 或内容块）；只用于把 steering 文本匹配回已持久化消息。
function userMessageText(message: { content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block): block is { type: "text"; text: string } =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
    .map(block => block.text).join("");
}

function noticeFor(outcome: "completed" | "stopped" | "failed", abortReason: AbortReason, providerError: string | undefined): string | null {
  if (outcome === "stopped") return "本回合已停止；停止前已完成的事实保持不变。";
  if (abortReason === "tool_limit") return "本回合达到工具调用上限，已提前结束；已完成的交付与提案保持不变，可继续发起新请求。";
  if (abortReason === "timeout") return "本回合超过时间上限，已提前结束；已完成的交付与提案保持不变，可继续发起新请求。";
  if (outcome === "failed") return providerError === "Connection error."
    ? "暂时无法连接文本模型，消息已保留；请稍后重试。"
    : "本回合执行失败，已提交的内容保持不变；请稍后重试。";
  return null;
}

// 供应商错误正文可能原样回显敏感内容（例如把 Key 拼进报错）：
// 日志出口对供应商失败映射固定原因，不透传原始错误文本；其余异常保留原文以便定位。
function providerFailureSummary(error: unknown, assistantEnd: { errorMessage?: string } | null): string {
  const message = error instanceof Error ? error.message : String(error);
  const providerMessage = assistantEnd?.errorMessage;
  if (providerMessage !== undefined && (message === providerMessage || message.endsWith(providerMessage))) {
    return `模型供应商请求失败（stopReason=error）`;
  }
  return message;
}

export class ConversationRunnerRegistry {
  private readonly runners = new Map<string, ConversationRunner>();

  constructor(private readonly options: ExecutorOptions) {}

  for(conversationId: string): ConversationRunner {
    const existing = this.runners.get(conversationId);
    if (existing) return existing;
    const runner = new ConversationRunner(conversationId, this.options, { current: null });
    this.runners.set(conversationId, runner);
    return runner;
  }

  kick(conversationId: string): void {
    this.for(conversationId).kick();
  }

  kickAllWithQueued(): void {
    const rows = this.options.db.prepare(
      "SELECT DISTINCT conversation_id FROM requests WHERE state = 'queued'",
    ).all() as { conversation_id: string }[];
    for (const row of rows) this.kick(row.conversation_id);
  }

  async reloadIdleSkills(): Promise<void> {
    for (const runner of this.runners.values()) await runner.reloadSkills();
  }

  invalidateIdleSessions(): void {
    for (const runner of this.runners.values()) runner.invalidateSession();
  }

  async close(): Promise<void> {
    await Promise.all([...this.runners.values()].map(runner => runner.dispose()));
    this.runners.clear();
  }
}

// 服务重启后的诚实中断：running@crash 的请求标记 failed + 系统通知 + Pi 安全分支；
// queued 请求保留，由 kickAllWithQueued 继续执行。
export function recoverInterruptedRequests(db: AgentDatabase, clock: AgentClock): string[] {
  const interrupted: string[] = [];
  const rows = db.prepare("SELECT * FROM requests WHERE state = 'running' ORDER BY queue_seq ASC").all() as RequestRow[];
  for (const request of rows) {
    db.transaction(() => {
      const fresh = db.prepare("SELECT * FROM requests WHERE id = ?").get(request.id) as RequestRow | undefined;
      if (!fresh || fresh.state !== "running") return;
      markRequestTerminal(db, clock(), fresh, "failed");
      finalizeRequestMessages(db, clock(), fresh, "failed");
      // 不伪造 toolResult，也不丢掉整条会话。下次显式请求在 Pi 原生树上从本轮开始前分支。
      const conversation = getConversation(db, fresh.owner_id, fresh.conversation_id)!;
      const checkpoint = conversation.pi_checkpoint_json ? JSON.parse(conversation.pi_checkpoint_json) as { requestId?: string; conversationId?: string; queueSeq?: number } : null;
      // 新格式的上轮检查点证明本轮尚未进入 prompt（写当前检查点是第一项历史变更之前的动作）。
      // 旧格式无法证明归属，保留恢复标记，下一请求会明确报告不能安全续接。
      const beforePrompt = checkpoint === null || (checkpoint.conversationId === fresh.conversation_id
        && checkpoint.requestId !== fresh.id && typeof checkpoint.queueSeq === "number" && checkpoint.queueSeq < fresh.queue_seq);
      db.prepare("UPDATE conversations SET pi_needs_recovery=? WHERE id=?").run(beforePrompt ? conversation.pi_needs_recovery : 1, fresh.conversation_id);
      insertMessage(db, clock(), {
        id: `ntc-${fresh.id.slice(4)}`, conversationId: fresh.conversation_id, ownerId: fresh.owner_id,
        requestId: fresh.id, role: "system_notice", kind: "notice", state: "completed",
        text: "服务重启导致本回合中断；已提交的成果保留。下一条请求会保留此前对话，从中断前的安全位置继续。",
        target: null, createdSeq: nextSeq(db, "messages", fresh.conversation_id), references: emptyReferences(),
      });
      interrupted.push(fresh.id);
    })();
  }
  return interrupted;
}
