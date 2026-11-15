import { readProviderConnections, saveProviderConnection, listAvailableProviderModels } from "./provider-connections.js";
import type {
  AcceptProposal, ArtifactHead, ArtifactRevision, Bootstrap, CancelRun, Conversation, ConversationPage,
  ContentSource, CreateConversation, FeedbackInput, FeedbackReceipt, LibrarySelection, LibraryVideo, LibraryVideoPage, Message,
  MessageInput, MessagePage, MessageReferences, ModelBinding, Proposal, ProposalPage, RenameConversation,
  RequestReceipt, RevisionRef, RunPage, Snapshot, StopRequest, Target,
  PrepareProposal, ProposalRef, SaveUserProfile, SaveUserProfileReceipt, UserProfile, Work, MaterialBatch,
  FreeServiceSettings, SaveFreeServiceSettingsReceipt, ImportedSettings, ProductionSpec,
  CreationBinding,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import { type EventHub, insertEvent, maxEventSeq, readEventsAfter, toBusinessEventPayload } from "./event-log.js";
import { decodeEventCursor, decodeListCursor, encodeEventCursor, encodeListCursor } from "./paging.js";
import { validatorFor } from "./validate.js";
import { newAgentId, type AgentClock } from "./util.js";
import {
  activeRequestId, checkCommandReceipt, emptyReferences, getConversation, getMessageRow, getRequestRow,
  insertConversation, insertMessage, insertQueuedRequest, listConversations, listMessageRows, listMessageRowsThrough,
  markStopRequested, maxConversationSeq, maxMessageSeq, nextQueueSeq, nextSeq, pendingRequestCount,
  renameConversationRow, requestReceipt, requireConversation, rowToConversation, rowToMessage,
  stopQueuedRequest, storeCommandReceipt, touchConversation, type RequestRow,
} from "./conversation-store.js";
import {
  feedbackNote, getArtifactRow, getProposalRow, getRevisionRow, insertRevision, listArtifactRows, listProposalRows,
  maxArtifactSeq, maxProposalSeq, rowToArtifactHead, rowToArtifactRevision, rowToProposal, productionAudioFacts,
  applyPrepareProposal, requirePaidProduction, sweepExpiredProposals, invalidateLegacyNarrationProposals, hasProductionLock, NARRATED_CATALOG_KEY, RENDER_CATALOG_KEY, TIMED_NARRATED_CATALOG_KEY,
  type QuoteCatalog, type RenderFileProbe,
} from "./artifact-store.js";
import { probeRenderInputs } from "./media-probe.js";
import { getWorkRow, listWorkRows, parseCreationState, recordReviewConfirmation, requireWork, withStandaloneApproval, workInFlight, workProjection } from "./creative-work.js";
import { adoptPreview } from "./preview-adoption.js";
import { listMaterialBatches, readMaterialBatch as readMaterialBatchRow } from "./material-store.js";
import { ConversationRunnerRegistry, recoverInterruptedRequests } from "./executor.js";
import type { PiRuntimeHost } from "./pi-runtime.js";
import type { SkillPackages } from "./skill-packages.js";
import type { CrashPointHook } from "./pi-tools.js";
import type { ProductionService } from "./production-service.js";
import { readUserProfile, saveUserProfile as saveUserProfileRow } from "./text-model-settings.js";
import {
  freeServiceIdOf, readFreeServiceSettings, saveKeyedServiceSettings, saveKeylessServiceSettings, saveNewsNowServiceSettings,
  saveEdgeTtsServiceSettings,
} from "./free-service-settings.js";
import type { SaveEdgeTtsSettings, SaveKeylessServiceSettings, SaveNewsNowSettings, SavePexelsSettings } from "../../shared/agent/generated/contracts.js";
import { toRun, runSegments, type RunRow } from "./production-store.js";
import { getScopedRunRow } from "./production-index.js";
import { retainedVideoMaterials } from "./library-materials.js";

// 面向 HTTP 的策略门面：契约校验、幂等、限额、确认短语、归属检查都在这里；
// 命令回执先于队列限额检查；任何 409/429/503 都不落业务状态。

const QUEUE_LIMIT = 20;
const PAGE_SIZE = 50;
const CONFIRMATION_PHRASES = ["开始制作", "按这份开始", "确认制作"] as const;

// 精确确认解析：NFKC → 去首尾空白 → 至多剥一个结尾句号/小数点 → 与白名单全等比较。
export function isExactConfirmation(text: string): boolean {
  const normalized = text.normalize("NFKC").trim().replace(/[。.]$/, "");
  return (CONFIRMATION_PHRASES as readonly string[]).includes(normalized);
}

export interface AgentServiceOptions {
  importedSettings?: ImportedSettings;
  providerConnections?: boolean;
  db: AgentDatabase;
  clock: AgentClock;
  hub: EventHub;
  host: PiRuntimeHost;
  registry: ConversationRunnerRegistry;
  /** 当前执行目录：每次读取时调用（与受理/prepare 同一事实源）。 */
  catalog: () => QuoteCatalog;
  /** 隔离/离线装配的静态目录（Faux 文本条目等）。 */
  models: Bootstrap["models"];
  /** 新消息接收事务冻结的默认文本绑定；null 表示尚未配置可用文本模型。 */
  defaultTextBinding: () => ModelBinding | null;
  /** 动态文本目录条目；提供时 Bootstrap 使用它替代静态文本条目。 */
  textModels?: () => Bootstrap["models"];
  /** 当前媒体目录条目；Bootstrap 合并静态与动态部分。 */
  mediaModels?: () => Bootstrap["models"];
  skills: () => Bootstrap["skills"];
  skillPackages?: SkillPackages;
  displayName: string;
  crashPoint?: CrashPointHook | undefined;
  production?: ProductionService;
}

export class AgentService {
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly crashPoint: CrashPointHook;

  constructor(private readonly options: AgentServiceOptions) {
    this.crashPoint = options.crashPoint ?? (() => {});
  }

  // —— Bootstrap ——

  bootstrap(ownerId: string): Bootstrap {
    return { ownerId, displayName: readUserProfile(this.options.db, ownerId, this.options.displayName).displayName,
      models: [...(this.options.textModels?.() ?? this.options.models), ...(this.options.mediaModels?.() ?? [])],
      skills: this.options.skills() };
  }

  // —— 应用专属原生 Skill 包 ——

  async readSkillPackages() {
    const packages = this.options.skillPackages;
    if (!packages) throw new AgentError("CAPABILITY_UNAVAILABLE", "当前入口没有 Skill 包管理能力。");
    if (packages.available || packages.mutation || packages.refreshing) return packages.read();
    packages.refreshing = true;
    try {
      // 管理后目录不可读时，GET 可以重试回读；正常列表读取沿当前已发布目录，不触碰运行中会话。
      await packages.reloadConfiguration();
      const view = await packages.refresh();
      await this.options.registry.reloadIdleSkills();
      return view;
    } catch (error) {
      packages.invalidate();
      this.options.registry.invalidateIdleSessions();
      throw error;
    } finally { packages.refreshing = false; }
  }

  async installSkillPackage(input: import("../../shared/agent/generated/contracts.js").InstallSkillPackage) {
    const verdict = validatorFor("InstallSkillPackage")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    return this.mutateSkillPackage("install", input.source);
  }

  async removeSkillPackage(input: import("../../shared/agent/generated/contracts.js").RemoveSkillPackage) {
    const verdict = validatorFor("RemoveSkillPackage")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    return this.mutateSkillPackage("remove", input.packageId);
  }

  private async mutateSkillPackage(action: "install" | "remove", value: string) {
    const packages = this.options.skillPackages;
    if (!packages) throw new AgentError("CAPABILITY_UNAVAILABLE", "当前入口没有 Skill 包管理能力。");
    if (packages.mutation || packages.refreshing || this.options.db.prepare("SELECT 1 FROM requests WHERE state IN ('queued','running') LIMIT 1").get()) {
      throw new AgentError("RUN_BUSY", "当前对话还在处理，完成后再操作 Skill。", { retryAction: "wait" });
    }
    const source = action === "install" ? value : packages.configuredPackage(value)?.source ?? value;
    packages.mutation = { action, source };
    let failure: unknown;
    try {
      if (action === "install") await packages.install(value);
      else await packages.remove(value);
    } catch (error) { failure = error; }
    try {
      // 安装/删除可能已改变文件：即便前一步失败也回读已持久配置和实际目录，不假称回滚。
      await packages.reloadConfiguration();
      await packages.refresh();
      await this.options.registry.reloadIdleSkills();
    } catch (error) {
      packages.invalidate();
      this.options.registry.invalidateIdleSessions();
      failure = error;
    } finally { packages.mutation = null; }
    if (failure) {
      if (failure instanceof AgentError) throw failure;
      throw new AgentError("TEMPORARILY_UNAVAILABLE", "Skill 操作或目录刷新失败，请读取当前列表核对；未自动重试或回滚。", { retryAction: "reload" });
    }
    return packages.read();
  }

  // —— 统一供应商连接 ——

  readProviderConnections() {
    if (!this.options.providerConnections) throw new AgentError("CAPABILITY_UNAVAILABLE", "当前入口未启用供应商连接设置。");
    return readProviderConnections(this.options.db);
  }

  saveProviderConnection(ownerId: string, input: unknown) {
    if (!this.options.providerConnections) throw new AgentError("CAPABILITY_UNAVAILABLE", "当前入口未启用供应商连接设置。");
    const result = saveProviderConnection(this.options.db, this.options.clock, ownerId, input);
    for (const id of result.changedConversations) this.options.hub.notifyCommitted(id);
    return result.receipt;
  }

  listAvailableProviderModels(connectionId: string) {
    if (!this.options.providerConnections) throw new AgentError("CAPABILITY_UNAVAILABLE", "当前入口未启用供应商连接设置。");
    return listAvailableProviderModels(this.options.db, connectionId);
  }

  readImportedSettings(ownerId: string): ImportedSettings {
    void ownerId;
    return this.options.importedSettings ?? [];
  }

  // —— 免费服务设置（素材来源与 NewsNow；与业务库同库，直接读写当前配置） ——

  readFreeServiceSettingsRow(ownerId: string, serviceId: string): FreeServiceSettings {
    void ownerId;
    return readFreeServiceSettings(this.options.db, freeServiceIdOf(serviceId));
  }

  saveFreeServiceSettings(ownerId: string, serviceId: string, input: unknown): SaveFreeServiceSettingsReceipt {
    const id = freeServiceIdOf(serviceId);
    if (id === "newsnow") return saveNewsNowServiceSettings(this.options.db, this.options.clock, ownerId, input as SaveNewsNowSettings);
    if (id === "edge-tts") return saveEdgeTtsServiceSettings(this.options.db, this.options.clock, ownerId, input as SaveEdgeTtsSettings);
    if (id === "pexels" || id === "pixabay" || id === "unsplash" || id === "coverr") {
      return saveKeyedServiceSettings(this.options.db, this.options.clock, ownerId, id, input as SavePexelsSettings);
    }
    return saveKeylessServiceSettings(this.options.db, this.options.clock, ownerId, id, input as SaveKeylessServiceSettings);
  }

  // —— 用户资料 ——

  readUserProfileRow(ownerId: string): UserProfile {
    return readUserProfile(this.options.db, ownerId, this.options.displayName);
  }

  saveUserProfile(ownerId: string, input: SaveUserProfile): SaveUserProfileReceipt {
    return saveUserProfileRow(this.options.db, this.options.clock, ownerId, input);
  }

  // —— 会话 ——

  createConversation(ownerId: string, input: CreateConversation): { conversation: Conversation; replayed: boolean } {
    const verdict = validatorFor("CreateConversation")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    const result = this.options.db.transaction(() => {
      const replay = checkCommandReceipt<Conversation>(this.options.db, {
        ownerId, operation: "createConversation", targetId: "new", commandId: input.commandId,
      }, input);
      if (replay.kind === "replay") return { conversation: replay.receipt, replayed: true };
      const id = newAgentId("cnv");
      const now = this.options.clock();
      insertConversation(this.options.db, now, {
        id, ownerId, title: input.title,
        createdSeq: maxConversationSeq(this.options.db, ownerId) + 1,
        piSessionId: "s1",
      });
      const conversation = rowToConversation(getConversation(this.options.db, ownerId, id)!);
      storeCommandReceipt(this.options.db, now, {
        ownerId, operation: "createConversation", targetId: "new", commandId: input.commandId,
      }, input, conversation);
      return { conversation, replayed: false };
    })();
    return result;
  }

  listConversations(ownerId: string, cursor: string | undefined, limit: number | undefined): ConversationPage {
    const pageSize = boundedPageSize(limit);
    const beforeSeq = cursor === undefined ? undefined : decodeListCursor(cursor, ownerId, "conversations").p;
    const fetched = listConversations(this.options.db, ownerId, pageSize + 1, beforeSeq);
    const rows = fetched.slice(0, pageSize);
    const watermark = cursor === undefined ? maxConversationSeq(this.options.db, ownerId) : decodeListCursor(cursor, ownerId, "conversations").w;
    return {
      items: rows.map(rowToConversation),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: ownerId, k: "conversations", w: watermark }),
      watermark: encodeListCursor({ v: 1, c: ownerId, k: "conversations", p: 0, w: watermark }),
    };
  }

  renameConversation(ownerId: string, conversationId: string, input: RenameConversation): Conversation {
    const verdict = validatorFor("RenameConversation")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    return this.options.db.transaction(() => {
      const replay = checkCommandReceipt<Conversation>(this.options.db, {
        ownerId, operation: "renameConversation", targetId: conversationId, commandId: input.commandId,
      }, input);
      if (replay.kind === "replay") return replay.receipt;
      const conversation = rowToConversation(renameConversationRow(this.options.db, this.options.clock(), ownerId, conversationId, input.title, input.expectedRevision));
      storeCommandReceipt(this.options.db, this.options.clock(), {
        ownerId, operation: "renameConversation", targetId: conversationId, commandId: input.commandId,
      }, input, conversation);
      return conversation;
    })();
  }

  // —— 快照与列表 ——

  snapshot(ownerId: string, conversationId: string): Snapshot {
    return this.options.db.transaction(() => {
      const conversation = rowToConversation(requireConversation(this.options.db, ownerId, conversationId));
      const messages = this.messagePage(ownerId, conversationId, undefined, PAGE_SIZE);
      const artifacts = this.artifactPage(ownerId, conversationId, undefined, PAGE_SIZE);
      const proposals = this.proposalPage(ownerId, conversationId, undefined, PAGE_SIZE);
      return {
        conversation,
        eventCursor: encodeEventCursor(conversationId, maxEventSeq(this.options.db, conversationId)),
        messages, artifacts, proposals,
        runs: this.runPage(conversationId, undefined, PAGE_SIZE),
        activeRequestId: activeRequestId(this.options.db, conversationId),
        works: listWorkRows(this.options.db, conversationId, 50).map(row => workProjection(this.options.db, row)),
        materialBatches: listMaterialBatches(this.options.db, conversationId, 100),
      };
    })();
  }

  // 批次详情与 Pi read_material_batch 共用同一只读内核；不让当前消息分页截断历史候选。
  readMaterialBatch(ownerId: string, batchId: string): MaterialBatch {
    const batch = readMaterialBatchRow(this.options.db, ownerId, batchId);
    if (!batch) throw new AgentError("NOT_FOUND", "没有找到这个素材批次。");
    return batch;
  }

  readWork(ownerId: string, workId: string): Work {
    const row = getWorkRow(this.options.db, ownerId, workId);
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这条视频创作。");
    return workProjection(this.options.db, row);
  }

  listMessages(ownerId: string, conversationId: string, cursor: string | undefined, limit: number | undefined, anchorMessageId?: string): MessagePage {
    requireConversation(this.options.db, ownerId, conversationId);
    if (anchorMessageId !== undefined) {
      // 定位窗口与翻页游标互斥；锚点必须属于本次 owner/会话，不能借窗口读其他会话历史。
      if (cursor !== undefined) throw new AgentError("INVALID_INPUT", "定位消息与分页游标互斥，请只传一种。");
      if (!anchorMessageId) throw new AgentError("INVALID_INPUT", "定位消息不能为空。");
      return this.anchorMessagePage(ownerId, conversationId, anchorMessageId, boundedPageSize(limit));
    }
    return this.messagePage(ownerId, conversationId, cursor, boundedPageSize(limit));
  }

  listArtifacts(ownerId: string, conversationId: string, cursor: string | undefined, limit: number | undefined) {
    requireConversation(this.options.db, ownerId, conversationId);
    return this.artifactPage(ownerId, conversationId, cursor, boundedPageSize(limit));
  }

  listProposals(ownerId: string, conversationId: string, cursor: string | undefined, limit: number | undefined): ProposalPage {
    requireConversation(this.options.db, ownerId, conversationId);
    return this.proposalPage(ownerId, conversationId, cursor, boundedPageSize(limit));
  }

  listRuns(ownerId: string, conversationId: string, cursor: string | undefined, limit: number | undefined): RunPage {
    requireConversation(this.options.db, ownerId, conversationId);
    return this.runPage(conversationId, cursor, boundedPageSize(limit));
  }

  private messagePage(ownerId: string, conversationId: string, cursor: string | undefined, pageSize: number): MessagePage {
    void ownerId;
    const beforeSeq = cursor === undefined ? undefined : decodeListCursor(cursor, conversationId, "messages").p;
    const fetched = listMessageRows(this.options.db, conversationId, pageSize + 1, beforeSeq);
    const rows = fetched.slice(0, pageSize);
    const watermark = cursor === undefined ? maxEventSeq(this.options.db, conversationId) : decodeListCursor(cursor, conversationId, "messages").w;
    return {
      items: rows.map(rowToMessage),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "messages", w: watermark }),
      watermark: encodeEventCursor(conversationId, watermark),
    };
  }

  // 定位窗口首页：锚点及其之前最近一页；watermark 取当前事件序号，后续事件按窗口规则合并。
  private anchorMessagePage(ownerId: string, conversationId: string, anchorMessageId: string, pageSize: number): MessagePage {
    const anchor = getMessageRow(this.options.db, ownerId, anchorMessageId);
    if (!anchor || anchor.conversation_id !== conversationId) throw new AgentError("NOT_FOUND", "定位的消息不在这份对话里。");
    const fetched = listMessageRowsThrough(this.options.db, conversationId, anchor.created_seq, pageSize + 1);
    const rows = fetched.slice(0, pageSize);
    const watermark = maxEventSeq(this.options.db, conversationId);
    return {
      items: rows.map(rowToMessage),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "messages", w: watermark }),
      watermark: encodeEventCursor(conversationId, watermark),
    };
  }

  // 作品库（§6）：从已有 finalize_video 认可与不可变修订/binding 只读投影，按视频修订去重，
  // 首次定稿时间倒序 + revisionId 稳定排序；重复定稿不把旧作品顶到最前。
  // 新表行都晚于旧表行（迁移时新表为空），流序为新表在前；游标把阶段编进 p（src*2^32+pos）。
  listLibraryVideos(ownerId: string, cursor: string | undefined, limit: number | undefined): LibraryVideoPage {
    const pageSize = boundedPageSize(limit);
    const beforePos = cursor === undefined ? undefined : decodeListCursor(cursor, ownerId, "library").p;
    const phase = beforePos === undefined ? undefined : Math.floor(beforePos / 2 ** 32);
    const newPos = beforePos === undefined ? null : phase === 1 ? 0 : beforePos;
    const legacyPos = phase === 1 ? beforePos : null;
    const db = this.options.db;
    const fetched = db.prepare(`
      SELECT * FROM (
        SELECT 0 AS src, rowid AS pos, conversation_id, work_id, subject_json, source_id, created_at
        FROM work_review_confirmations
        WHERE owner_id = ? AND subject_scope = 'work_item' AND action = 'finalize_video'
          AND rowid = (SELECT MIN(f2.rowid) FROM work_review_confirmations f2
                       WHERE f2.owner_id = work_review_confirmations.owner_id AND f2.action = 'finalize_video'
                         AND json_extract(f2.subject_json, '$.revisionId') = json_extract(work_review_confirmations.subject_json, '$.revisionId'))
          AND (? IS NULL OR rowid < ?)
        UNION ALL
        SELECT 1 AS src, rowid AS pos, conversation_id, work_id, subject_json, source_id, created_at
        FROM work_stage_confirmations
        WHERE owner_id = ? AND action = 'finalize_video'
          AND rowid = (SELECT MIN(f2.rowid) FROM work_stage_confirmations f2
                       WHERE f2.owner_id = work_stage_confirmations.owner_id AND f2.action = 'finalize_video'
                         AND json_extract(f2.subject_json, '$.revisionId') = json_extract(work_stage_confirmations.subject_json, '$.revisionId'))
          AND (? IS NULL OR rowid < ?)
      )
      ORDER BY src ASC, pos DESC
      LIMIT ?`).all(ownerId, newPos, newPos, ownerId, legacyPos, legacyPos, pageSize + 1) as LibraryConfirmationRow[];
    const seen = new Set<string>();
    const items: LibraryVideo[] = [];
    for (const row of fetched.slice(0, pageSize)) {
      const revisionId = (JSON.parse(row.subject_json) as { revisionId?: string }).revisionId;
      if (revisionId) {
        if (seen.has(revisionId)) continue;
        seen.add(revisionId);
      }
      const entry = this.libraryVideoEntry(ownerId, row);
      if (entry) items.push(entry);
    }
    return {
      items,
      nextCursor: fetched.length > pageSize
        ? encodeListCursor({ v: 1, c: ownerId, k: "library", p: fetched[pageSize - 1]!.src * 2 ** 32 + fetched[pageSize - 1]!.pos, w: 0 })
        : null,
    };
  }

  // 单条作品事实：视频修订 → 所属运行 → 提案的 plan binding → 当时 content binding，全部读不可变行；
  // 任一环节缺失就置 null（历史无准确来源标记未记录），不拿当前 head 补齐。产出位置定位到
  // 运行首次终态时插入的 system_notice（references 带同一 run 与该视频修订），没有就 null。
  private libraryVideoEntry(ownerId: string, row: LibraryConfirmationRow): LibraryVideo | null {
    const db = this.options.db;
    const subject = JSON.parse(row.subject_json) as ContentSource;
    if (subject.kind !== "artifact_revision") return null;
    const artifact = getArtifactRow(db, ownerId, subject.artifactId);
    const revision = getRevisionRow(db, subject.artifactId, subject.revisionId);
    if (!artifact || !revision || artifact.kind !== "video") return null;
    let plan: RevisionRef | null = null;
    let content: ContentSource | null = null;
    let originMessageId: string | null = null;
    let narrationText: string | null = null;
    let audioSummary: LibraryVideo["audioSummary"];
    const retained = retainedVideoMaterials(db, ownerId, subject);
    const producer = retained.producer;
    if (producer) {
      const run = db.prepare("SELECT id, proposal_id FROM production_runs WHERE id = ? AND owner_id = ?")
        .get(producer.runId, ownerId) as { id: string; proposal_id: string | null } | undefined;
      if (run) {
        const audio = productionAudioFacts(db, { ...producer.spec,
          finalOutput: { operationId: producer.operationId, outputSlot: producer.outputSlot } }, producer.runOrder);
        narrationText = audio.narrationText;
        audioSummary = audio.audioSummary;
        const proposal = run.proposal_id ? getProposalRow(db, ownerId, run.proposal_id) : undefined;
        const planSource = proposal?.plan_source_json ? JSON.parse(proposal.plan_source_json) as { artifactId?: string; revisionId?: string } : null;
        if (planSource?.artifactId && planSource?.revisionId) {
          const planRevision = getRevisionRow(db, planSource.artifactId, planSource.revisionId);
          if (planRevision) {
            plan = { artifactId: planSource.artifactId, revisionId: planSource.revisionId };
            const binding = planRevision.creation_binding_json ? JSON.parse(planRevision.creation_binding_json) as { source?: ContentSource } : null;
            if (binding?.source) content = binding.source;
          }
        }
        originMessageId = (db.prepare(`
          SELECT m.id FROM messages m
          WHERE m.owner_id = ? AND m.conversation_id = ? AND m.role = 'system_notice'
            AND EXISTS (SELECT 1 FROM json_each(m.references_json, '$.runIds') je WHERE je.value = ?)
            AND EXISTS (SELECT 1 FROM json_each(m.references_json, '$.artifacts') ja
                        WHERE json_extract(ja.value, '$.revisionId') = ?)
          ORDER BY m.created_seq DESC LIMIT 1`).get(ownerId, row.conversation_id, run.id, subject.revisionId) as { id: string } | undefined)?.id ?? null;
      }
    }
    // 新组模型来源（§4.3）：定稿当时的冻结绑定记录工程、素材与认可来源；
    // 旧阶段绑定未记录这些来源，如实标 not_recorded，不从当前 head 补齐。
    const parsedBinding = revision.creation_binding_json ? JSON.parse(revision.creation_binding_json) as CreationBinding : null;
    const modernBinding = parsedBinding && Array.isArray(parsedBinding.inputSources) ? parsedBinding : null;
    // 准确输出的实际消费集合与选材授权共用；原始blob保留run/操作/输入位置，不造修订。
    const materials = retained.materials;
    if (modernBinding?.adoptedFrom) originMessageId = row.source_id;
    // §11.7 来源3：多工程合成的定稿沿来源链展开全部封存工程的文件清单，每行 project 指明所属
    // 工程，同名 relativePath 不会指到另一个工程；最终主工程（projectRevision）分组在前，
    // 纯拼接合成没有主工程时 project 为 null 而清单非空。读取只沿既有记录去重，不补当前 head。
    const projectFiles: LibraryVideo["projectFiles"] = [];
    if (retained.projects.length) {
      const seenProjects = new Set<string>();
      for (const projectRef of retained.projects) {
        if (!projectRef || seenProjects.has(projectRef.revisionId)) continue;
        seenProjects.add(projectRef.revisionId);
        const projectRevision = getRevisionRow(db, projectRef.artifactId, projectRef.revisionId);
        const content = projectRevision ? JSON.parse(projectRevision.content_json) as { format?: string; files?: { relativePath: string; blobId: string }[] } : null;
        if (content?.format !== "project") continue;
        for (const file of content.files ?? []) {
          const blob = db.prepare("SELECT mime_type FROM production_blobs WHERE id=? AND owner_id=?")
            .get(file.blobId, ownerId) as { mime_type: string } | undefined;
          if (blob) projectFiles.push({ project: { artifactId: projectRef.artifactId, revisionId: projectRef.revisionId },
            relativePath: file.relativePath, mimeType: blob.mime_type });
        }
      }
    }
    return {
      video: { artifactId: subject.artifactId, revisionId: subject.revisionId },
      workId: row.work_id, conversationId: row.conversation_id, title: artifact.title,
      finalizedAt: row.created_at, plan, content, originMessageId, narrationText, ...(audioSummary ? { audioSummary } : {}),
      project: modernBinding?.projectRevision ?? null,
      projectFiles,
      materials,
      reviewSources: modernBinding?.reviewInputs ?? [],
      provenanceStatus: modernBinding ? "recorded" : "not_recorded",
    };
  }

  private artifactPage(ownerId: string, conversationId: string, cursor: string | undefined, pageSize: number) {
    void ownerId;
    const beforeSeq = cursor === undefined ? undefined : decodeListCursor(cursor, conversationId, "artifacts").p;
    const fetched = listArtifactRows(this.options.db, conversationId, pageSize + 1, beforeSeq);
    const rows = fetched.slice(0, pageSize);
    const watermark = cursor === undefined ? maxEventSeq(this.options.db, conversationId) : decodeListCursor(cursor, conversationId, "artifacts").w;
    return {
      items: rows.map(row => withStandaloneApproval(this.options.db, rowToArtifactHead(row))),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "artifacts", w: watermark }),
      watermark: encodeEventCursor(conversationId, watermark),
    };
  }

  private proposalPage(ownerId: string, conversationId: string, cursor: string | undefined, pageSize: number): ProposalPage {
    void ownerId;
    const beforeSeq = cursor === undefined ? undefined : decodeListCursor(cursor, conversationId, "proposals").p;
    const fetched = listProposalRows(this.options.db, conversationId, pageSize + 1, beforeSeq);
    const rows = fetched.slice(0, pageSize);
    const watermark = cursor === undefined ? maxEventSeq(this.options.db, conversationId) : decodeListCursor(cursor, conversationId, "proposals").w;
    return {
      items: rows.map(row => rowToProposal(row, this.options.db, this.options.catalog())),
      nextCursor: pageCursor(fetched, pageSize, { v: 1, c: conversationId, k: "proposals", w: watermark }),
      watermark: encodeEventCursor(conversationId, watermark),
    };
  }

  private runPage(conversationId: string, cursor: string | undefined, limit: number): RunPage {
    const before = cursor === undefined ? undefined : decodeListCursor(cursor, conversationId, "runs").p;
    const rows = (before === undefined
      ? this.options.db.prepare("SELECT * FROM production_runs WHERE conversation_id=? ORDER BY created_seq DESC LIMIT ?").all(conversationId, limit + 1)
      : this.options.db.prepare("SELECT * FROM production_runs WHERE conversation_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT ?").all(conversationId, before, limit + 1)) as RunRow[];
    return {
      items: rows.slice(0, limit).map(row => toRun(this.options.db, row)),
      nextCursor: pageCursor(rows, limit, { v: 1, c: conversationId, k: "runs", w: maxEventSeq(this.options.db, conversationId) }),
      watermark: encodeEventCursor(conversationId, maxEventSeq(this.options.db, conversationId)),
    };
  }

  // —— 发送 / 停止 ——

  sendMessage(ownerId: string, conversationId: string, input: MessageInput): Promise<{ status: 202; receipt: RequestReceipt }> | { status: 202; receipt: RequestReceipt } {
    const verdict = validatorFor("MessageInput")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    requireConversation(this.options.db, ownerId, conversationId);

    const replay = this.options.db.transaction(() =>
      checkCommandReceipt<RequestReceipt>(this.options.db, {
        ownerId, operation: "sendMessage", targetId: conversationId, commandId: input.commandId,
      }, input))();
    if (replay.kind === "replay") return { status: 202, receipt: { ...replay.receipt, replayed: true } };

    // 消息明确指向的组审阅上下文（C2/F05）：与确认/提案/目标的互斥已由 MessageInput 契约
    // 在上方校验一次；这里只核对指向真实存在，避免双作品会话里继续到错误对象。
    if (input.reviewContext) {
      const work = requireWork(this.options.db, ownerId, conversationId, input.reviewContext.workId);
      if (!parseCreationState(work).groups.some(group => group.id === input.reviewContext!.groupId)) {
        throw new AgentError("INVALID_INPUT", "消息指向的审阅组不存在。");
      }
    }

    // 组审阅认可来自按钮的真实动作，先于普通发送；纯认可不需要文本模型，也不受技能刷新影响。
    if (input.reviewConfirmation) return this.sendReviewConfirmation(ownerId, conversationId, input);

    if (this.options.skillPackages?.mutation || this.options.skillPackages?.refreshing) throw new AgentError("RUN_BUSY", "正在管理或读取 Skill，请完成后再发送；输入内容已保留。", { retryAction: "wait" });

    if (input.proposalRef) {
      const referenced = this.visibleProposal(ownerId, input.proposalRef);
      if (referenced.conversationId !== conversationId) throw new AgentError("NOT_FOUND", "当前会话中没有这个提案。");
      if (isExactConfirmation(input.text)) {
        if (!this.options.production) throw new AgentError("CAPABILITY_UNAVAILABLE", "制作能力尚未接入，暂不能受理确认；提案保留，可以先继续讨论。");
        return { status: 202, receipt: this.options.production.acceptMessage(ownerId, conversationId, input) };
      }
    }

    if (input.mode === "steer") {
      return this.sendSteer(ownerId, conversationId, input);
    }
    return this.sendNew(ownerId, conversationId, input);
  }

  // 组审阅认可（按钮）：认可在接收事务里直接记录，不进 Pi；只有“认可并继续”排一次现有队列请求，
  // 让助手基于认可后的事实继续后续组工作。失败整体回滚，不留半份认可或队列。
  private sendReviewConfirmation(ownerId: string, conversationId: string, input: MessageInput): { status: 202; receipt: RequestReceipt } {
    const confirmation = input.reviewConfirmation!;
    const queues = confirmation.action === "approve_and_continue";
    if (queues) this.options.skillPackages?.resources();
    const receipt = this.options.db.transaction(() => {
      // 文本模型只在排 Pi 请求时需要；纯认可即使没有可用文本模型也能完成。
      const binding = queues ? this.options.defaultTextBinding() : null;
      if (queues && !binding) throw new AgentError("CAPABILITY_UNAVAILABLE", "尚未配置可用的文本模型，暂不能继续后续工作；认可未写入。");
      if (queues && pendingRequestCount(this.options.db, conversationId) >= QUEUE_LIMIT) {
        throw new AgentError("QUEUE_FULL", "本会话待处理消息已达上限，请等待当前回合完成。");
      }
      if (queues && input.skillId && !this.options.skills().some(skill => skill.id === input.skillId)) {
        throw new AgentError("INVALID_INPUT", "未安装这个技能。");
      }
      const now = this.options.clock(), requestId = newAgentId("req"), messageId = newAgentId("msg");
      const references: MessageReferences = {
        ...emptyReferences(),
        artifacts: "kind" in confirmation
          ? [confirmation.kind === "standalone_artifact"
            ? { artifactId: confirmation.artifactId, revisionId: confirmation.revisionId } : confirmation.source]
          : confirmation.items.flatMap(item => item.source.kind === "artifact_revision"
            ? [{ artifactId: item.source.artifactId, revisionId: item.source.revisionId }] : []),
      };
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId, role: "user", kind: "chat",
        state: queues ? "queued" : "completed", text: input.text,
        target: null,
        createdSeq: nextSeq(this.options.db, "messages", conversationId), references,
        reviewConfirmation: confirmation,
      });
      insertQueuedRequest(this.options.db, now, {
        id: requestId, conversationId, ownerId, commandId: input.commandId, text: input.text,
        target: null, skillId: queues ? input.skillId : null, modelId: binding?.modelId ?? null,
        queueSeq: nextQueueSeq(this.options.db, conversationId), messageId,
      });
      if (binding) this.options.db.prepare("UPDATE requests SET model_binding_json=? WHERE id=?").run(JSON.stringify(binding), requestId);
      else this.options.db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(requestId);
      const scope = { ownerId, conversationId }, origin = { kind: "user_message" as const, messageId };
      if ("kind" in confirmation) {
        if (confirmation.kind === "adopt_preview") adoptPreview(this.options.db, now, scope, confirmation, origin);
        else recordReviewConfirmation(this.options.db, now, scope, confirmation, origin);
      } else recordReviewConfirmation(this.options.db, now, scope, confirmation, origin);
      const row = getRequestRow(this.options.db, ownerId, requestId)!;
      const result = requestReceipt(row, false);
      storeCommandReceipt(this.options.db, now, {
        ownerId, operation: "sendMessage", targetId: conversationId, commandId: input.commandId,
      }, input, result);
      touchConversation(this.options.db, now, conversationId);
      return result;
    })();
    this.options.hub.notifyCommitted(conversationId);
    if (queues) this.options.registry.kick(conversationId);
    return { status: 202, receipt };
  }

  private sendNew(ownerId: string, conversationId: string, input: MessageInput): { status: 202; receipt: RequestReceipt } {    this.options.skillPackages?.resources();
    // G4-2：作品库选材的入口验证在事务外完成（对冻结工程修订与 blob 行的读取，publishProject 同模式）。
    const libraryPlan = input.librarySelections?.length ? this.planLibrarySelections(ownerId, input.librarySelections) : null;
    const receipt = this.options.db.transaction(() => {
      // 接收事务内冻结默认条目的完整绑定：执行配置/Key 的后续编辑不影响已接收请求。
      const binding = this.options.defaultTextBinding();
      if (!binding) throw new AgentError("CAPABILITY_UNAVAILABLE", "尚未配置可用的文本模型，请先配置后发送。");
      if (pendingRequestCount(this.options.db, conversationId) >= QUEUE_LIMIT) {
        throw new AgentError("QUEUE_FULL", "本会话待处理消息已达上限，请等待当前回合完成。");
      }
      if (input.target) this.requireTarget(ownerId, conversationId, input.target);
      if (input.skillId && !this.options.skills().some(skill => skill.id === input.skillId)) {
        throw new AgentError("INVALID_INPUT", "未安装这个技能。");
      }
      const references: MessageReferences = input.proposalRef
        ? { ...emptyReferences(), proposalIds: [input.proposalRef.proposalId] }
        : emptyReferences();
      const now = this.options.clock();
      const requestId = newAgentId("req");
      const messageId = newAgentId("msg");
      // 物化只读原修订/工程清单建立当前会话新副本，不写原会话 artifact head（§6）。
      if (libraryPlan) references.artifacts.push(...this.materializeLibrarySelections(ownerId, conversationId, now, requestId, libraryPlan));
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId,
        role: "user", kind: "chat", state: "queued", text: input.text, target: input.target,
        createdSeq: nextSeq(this.options.db, "messages", conversationId), references,
        ...(input.librarySelections?.length ? { librarySelections: input.librarySelections } : {}),
        reviewContext: input.reviewContext ?? null,
      });
      insertQueuedRequest(this.options.db, now, {
        id: requestId, conversationId, ownerId, commandId: input.commandId, text: input.text,
        target: input.target, skillId: input.skillId, modelId: binding.modelId,
        queueSeq: nextQueueSeq(this.options.db, conversationId),
        messageId,
      });
      this.options.db.prepare("UPDATE requests SET model_binding_json=? WHERE id=?").run(JSON.stringify(binding), requestId);
      const row = getRequestRow(this.options.db, ownerId, requestId)!;
      const receipt = requestReceipt(row, false);
      storeCommandReceipt(this.options.db, now, {
        ownerId, operation: "sendMessage", targetId: conversationId, commandId: input.commandId,
      }, input, receipt);
      touchConversation(this.options.db, now, conversationId);
      return receipt;
    })();
    // 发送事务已提交、响应尚未返回——F7 发送重放窗口。
    this.crashPoint("after-send-commit");
    this.options.hub.notifyCommitted(conversationId);
    this.options.registry.kick(conversationId);
    return { status: 202, receipt };
  }

  // G4-2 入口验证：所选视频必须是本 owner 名下真实 finalize_video 认可的准确修订，
  // 所选素材/工程文件必须落在该定稿当时冻结的留存清单（modernBinding）里。
  // 只授权本次明确引用进入当前对话；同 owner 其他会话不因此默认可读。
  private planLibrarySelections(ownerId: string, selections: readonly LibrarySelection[]): { kind: string; title: string; content: ArtifactRevision["content"] }[] {
    const db = this.options.db;
    const items: { kind: string; title: string; content: ArtifactRevision["content"] }[] = [];
    for (const selection of selections) {
      const confirmed = db.prepare(`
        SELECT 1 AS ok FROM (
          SELECT subject_json FROM work_review_confirmations WHERE owner_id=? AND action='finalize_video'
          UNION ALL
          SELECT subject_json FROM work_stage_confirmations WHERE owner_id=? AND action='finalize_video'
        ) WHERE json_extract(subject_json,'$.revisionId')=? AND json_extract(subject_json,'$.artifactId')=?`)
        .get(ownerId, ownerId, selection.sourceVideo.revisionId, selection.sourceVideo.artifactId);
      if (!confirmed) throw new AgentError("INVALID_INPUT", "所选视频还没有定稿入库，不能作为作品库来源。");
      const videoArtifact = getArtifactRow(db, ownerId, selection.sourceVideo.artifactId);
      const videoRevision = getRevisionRow(db, selection.sourceVideo.artifactId, selection.sourceVideo.revisionId);
      if (!videoArtifact || !videoRevision || videoArtifact.kind !== "video") {
        throw new AgentError("INVALID_INPUT", "作品库来源不是有效的视频修订。");
      }
      const retained = retainedVideoMaterials(db, ownerId, selection.sourceVideo);
      const picked = selection.source;
      if (picked.kind === "artifact_revision") {
        const source = retained.materials.map(item => item.source).find(item => !("kind" in item)
          && item.artifactId === picked.artifactId && item.revisionId === picked.revisionId);
        if (!source || "kind" in source) throw new AgentError("INVALID_INPUT", "所选素材不在定稿当时的留存清单里。");
        const artifact = getArtifactRow(db, ownerId, source.artifactId);
        const revision = getRevisionRow(db, source.artifactId, source.revisionId);
        if (!artifact || !revision) throw new AgentError("INVALID_INPUT", "所选素材修订已不存在。");
        items.push({ kind: artifact.kind, title: `${artifact.title}（作品库引用）`, content: JSON.parse(revision.content_json) });
      } else if (picked.kind === "run_input") {
        const material = retained.materials.find(item => "kind" in item.source && item.source.kind === "run_input"
          && item.source.runId === picked.runId && item.source.operationId === picked.operationId
          && item.source.inputIndex === picked.inputIndex && item.source.blobId === picked.blobId);
        if (!material) throw new AgentError("INVALID_INPUT", "所选原始素材不在这版成片实际采用的输入里。");
        const blob = this.options.production!.blobs.get(ownerId, picked.blobId);
        if (blob.mime_type !== "video/mp4" && blob.mime_type !== "video/webm" && blob.mime_type !== "image/png"
          && blob.mime_type !== "image/jpeg" && blob.mime_type !== "audio/mpeg" && blob.mime_type !== "audio/wav") {
          throw new AgentError("INVALID_INPUT", "所选原始素材不是可复用媒体。");
        }
        items.push({ kind: material.kind, title: `${material.label}（作品库引用）`, content: {
          format: "media", blobId: blob.id, mimeType: blob.mime_type, durationMs: blob.duration_ms,
          ...(material.provenance.length ? { sources: material.provenance } : {}),
        } });
      } else {
        // §11.7 来源3：多工程合成的定稿允许引用来源链上任一封存工程；同名 relativePath 按所选工程区分。
        const project = retained.projects.find(ref => ref.artifactId === picked.project.artifactId && ref.revisionId === picked.project.revisionId);
        if (!project) {
          throw new AgentError("INVALID_INPUT", "所选文件不在定稿封存工程里。");
        }
        const revision = getRevisionRow(db, project.artifactId, project.revisionId);
        const content = revision ? JSON.parse(revision.content_json) as { format?: string; files?: { relativePath: string; blobId: string }[] } : null;
        const file = content?.format === "project" ? content.files?.find(item => item.relativePath === picked.relativePath) : undefined;
        if (!file) throw new AgentError("INVALID_INPUT", "所选文件不在定稿封存工程清单里。");
        const blob = db.prepare("SELECT digest, mime_type, duration_ms FROM production_blobs WHERE id=? AND owner_id=?")
          .get(file.blobId, ownerId) as { digest: string; mime_type: string; duration_ms: number | null } | undefined;
        if (!blob) throw new AgentError("INVALID_INPUT", "所选工程文件已不存在。");
        if (blob.mime_type === "video/mp4" || blob.mime_type === "video/webm" || blob.mime_type === "image/png"
          || blob.mime_type === "image/jpeg" || blob.mime_type === "audio/mpeg" || blob.mime_type === "audio/wav") {
          // 媒体工程文件只共享 blob、不复制字节；物化修订自动登记 revision_blob_links。
          items.push({ kind: blob.mime_type.split("/")[0]!, title: `${picked.relativePath}（作品库引用）`,
            content: { format: "media", blobId: file.blobId, mimeType: blob.mime_type, durationMs: blob.duration_ms } });
        } else {
          // §11.7 来源5：其余工程文件一律保留原字节共享 blob、原相对路径与登记 MIME 的文件卡，
          // 不再默认 utf8 转文稿；字体、模型、压缩包等二进制由 read_artifact/客户端如实呈现或下载。
          items.push({ kind: "file", title: `${picked.relativePath}（作品库引用）`,
            content: { format: "file", blobId: file.blobId, mimeType: blob.mime_type, path: picked.relativePath } });
        }
      }
    }
    return items;
  }

  // G4-2 物化：把已验证的选材在当前会话建立新 artifact 修订（原素材只读引用或新副本派生），
  // 返回填入消息 references 的准确修订引用；不修改原会话任何 artifact head。
  private materializeLibrarySelections(
    ownerId: string, conversationId: string, now: string, requestId: string,
    plan: readonly { kind: string; title: string; content: ArtifactRevision["content"] }[],
  ): MessageReferences["artifacts"] {
    const refs: MessageReferences["artifacts"] = [];
    for (const item of plan) {
      const artifactId = newAgentId("art");
      this.options.db.prepare(
        `INSERT INTO artifacts(id, conversation_id, owner_id, title, kind, work_id, head_revision_id, head_revision_number, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
      ).run(artifactId, conversationId, ownerId, item.title, item.kind,
        nextSeq(this.options.db, "artifacts", conversationId), now, now);
      const revision = insertRevision(this.options.db, now, getArtifactRow(this.options.db, ownerId, artifactId)!, null,
        { title: item.title, kind: item.kind, content: item.content }, requestId);
      refs.push({ artifactId, revisionId: revision.id });
    }
    return refs;
  }

  private async sendSteer(ownerId: string, conversationId: string, input: MessageInput): Promise<{ status: 202; receipt: RequestReceipt }> {
    const requestId = input.steerRequestId!;
    const request = this.options.db.transaction(() => {
      const row = getRequestRow(this.options.db, ownerId, requestId);
      if (!row || row.conversation_id !== conversationId) throw new AgentError("NOT_FOUND", "没有找到这个请求。");
      if (row.state !== "running" || row.stop_requested) throw new AgentError("REQUEST_NOT_RUNNING", "请求已结束，steer 必须绑定正在运行的回合。");
      if (input.target && (!row.target_json || !sameTarget(JSON.parse(row.target_json) as Target, input.target))) {
        throw new AgentError("TARGET_SCOPE_MISMATCH", "steer 不能改变请求绑定的目标。");
      }
      return row;
    })();

    const runner = this.options.registry.for(conversationId);
    let receipt: RequestReceipt | undefined;
    let messageId: string | undefined;
    const applied = await runner.steerActive(requestId, input.text, () => {
      receipt = this.options.db.transaction(() => {
        const now = this.options.clock();
        messageId = newAgentId("msg");
        insertMessage(this.options.db, now, {
          id: messageId, conversationId, ownerId, requestId,
          role: "user", kind: "chat", state: "running", text: input.text, target: input.target,
          createdSeq: nextSeq(this.options.db, "messages", conversationId), references: emptyReferences(),
          reviewContext: input.reviewContext ?? null,
        });
        const result = { ...requestReceipt(request, false), messageId };
        storeCommandReceipt(this.options.db, now, {
          ownerId, operation: "sendMessage", targetId: conversationId, commandId: input.commandId,
        }, input, result);
        return result;
      })();
      return messageId!;
    });
    if (applied !== "applied" || !receipt) {
      if (messageId) this.options.db.transaction(() => {
        this.options.db.prepare("UPDATE messages SET state='failed', revision=revision+1 WHERE id=?").run(messageId!);
        const changed = getMessageRow(this.options.db, ownerId, messageId!)!;
        insertEvent(this.options.db, this.options.clock(), { conversationId, ownerId, kind: "message.changed", entityId: messageId!, entityVersion: changed.revision });
        this.options.db.prepare("UPDATE command_receipts SET receipt_json=? WHERE owner_id=? AND operation='sendMessage' AND target_id=? AND command_id=?")
          .run(JSON.stringify({ ...receipt!, state: "failed" }), ownerId, conversationId, input.commandId);
      })();
      this.options.hub.notifyCommitted(conversationId);
      throw new AgentError("REQUEST_NOT_RUNNING", "请求刚好已结束，干预未生效，请作为新消息发送。");
    }
    this.options.hub.notifyCommitted(conversationId);
    return { status: 202, receipt };
  }

  stopRequest(ownerId: string, requestId: string, input: StopRequest): RequestReceipt {
    const verdict = validatorFor("StopRequest")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    const receipt = this.options.db.transaction(() => {
      const replay = checkCommandReceipt<RequestReceipt>(this.options.db, {
        ownerId, operation: "stopRequest", targetId: requestId, commandId: input.commandId,
      }, input);
      if (replay.kind === "replay") return replay.receipt;
      const row = this.options.db.prepare("SELECT * FROM requests WHERE id = ? AND owner_id = ?")
        .get(requestId, ownerId) as RequestRow | undefined;
      if (!row) throw new AgentError("NOT_FOUND", "没有找到这个请求。");
      if (row.state !== "queued" && row.state !== "running") {
        throw new AgentError("REQUEST_NOT_RUNNING", "请求已结束，无需停止。");
      }
      const now = this.options.clock();
      markStopRequested(this.options.db, now, requestId);
      if (row.state === "queued") {
        stopQueuedRequest(this.options.db, now, row);
      }
      const fresh = getRequestRow(this.options.db, ownerId, requestId)!;
      const receipt = requestReceipt({ ...fresh, state: "stopped" }, false);
      storeCommandReceipt(this.options.db, now, {
        ownerId, operation: "stopRequest", targetId: requestId, commandId: input.commandId,
      }, input, receipt);
      return receipt;
    })();
    const row = getRequestRow(this.options.db, ownerId, requestId);
    if (row?.state === "running") this.options.registry.for(row.conversation_id).stopIfRunning(requestId);
    if (row) this.options.hub.notifyCommitted(row.conversation_id);
    return receipt;
  }

  // —— 读取 ——

  readMessage(ownerId: string, messageId: string): Message {
    const row = getMessageRow(this.options.db, ownerId, messageId);
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这条消息。");
    return rowToMessage(row);
  }

  readArtifactHead(ownerId: string, artifactId: string): ArtifactHead {
    const row = getArtifactRow(this.options.db, ownerId, artifactId);
    if (!row || !row.head_revision_id) throw new AgentError("NOT_FOUND", "没有找到这个产物。");
    return withStandaloneApproval(this.options.db, rowToArtifactHead(row));
  }

  readRevision(ownerId: string, artifactId: string, revisionId: string): ArtifactRevision {
    const artifact = getArtifactRow(this.options.db, ownerId, artifactId);
    const revision = artifact ? getRevisionRow(this.options.db, artifactId, revisionId) : undefined;
    if (!artifact || !revision) throw new AgentError("NOT_FOUND", "没有找到这个产物修订。");
    return rowToArtifactRevision(revision);
  }

  // —— 反馈 ——

  addFeedback(ownerId: string, conversationId: string, input: FeedbackInput): { status: 201; receipt: FeedbackReceipt; replayed: boolean } {
    const verdict = validatorFor("FeedbackInput")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    let replayed = false;
    const receipt = this.options.db.transaction(() => {
      requireConversation(this.options.db, ownerId, conversationId);
      const replay = checkCommandReceipt<FeedbackReceipt>(this.options.db, {
        ownerId, operation: "addFeedback", targetId: input.target.artifactId, commandId: input.commandId,
      }, input);
      if (replay.kind === "replay") {
        replayed = true;
        return replay.receipt;
      }
      this.requireTarget(ownerId, conversationId, input.target);
      const now = this.options.clock();
      const messageId = newAgentId("msg");
      // 制作在途时对该事项的意见都属于下一版（与 record_work_feedback 同一判定）；受理依据不拦改稿，
      // 只影响意见归属；无事项关联的散件再看输入锁。
      const note = input.target.workId !== null && workInFlight(this.options.db, input.target.workId)
        || hasProductionLock(this.options.db, input.target.artifactId)
        ? feedbackNote("next_version") : feedbackNote();
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId: null,
        role: "user", kind: "feedback", state: "completed", text: input.text, target: input.target,
        createdSeq: nextSeq(this.options.db, "messages", conversationId),
        references: { ...emptyReferences(), artifacts: [{ artifactId: input.target.artifactId, revisionId: input.target.revisionId }] },
        feedback: note,
      });
      const receipt: FeedbackReceipt = {
        target: input.target, workId: null, contentSource: null,
        applied: note.applied, disposition: note.disposition,
        replayed: false, messageId, messageRevision: 1,
      };
      storeCommandReceipt(this.options.db, now, {
        ownerId, operation: "addFeedback", targetId: input.target.artifactId, commandId: input.commandId,
      }, input, receipt);
      return receipt;
    })();
    this.options.hub.notifyCommitted(conversationId);
    return { status: 201, receipt, replayed };
  }

  // —— 提案 ——

  async prepareProposal(ownerId: string, conversationId: string, input: PrepareProposal): Promise<{ status: 201; proposal: Proposal; replayed: boolean }> {
    const verdict = validatorFor("PrepareProposal")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    requireConversation(this.options.db, ownerId, conversationId);
    const key = { ownerId, operation: "prepareProposal", targetId: conversationId, commandId: input.commandId };
    const prior = checkCommandReceipt<Proposal>(this.options.db, key, input);
    if (prior.kind === "replay") return { status: 201, proposal: prior.receipt, replayed: true };
    requirePaidProduction(input.spec);
    // 付费前探测：真实 render 目录（任一 assembly 分支）要求已有输入文件可读（事务外执行）。
    let probes: Map<string, RenderFileProbe> | undefined;
    if (this.options.catalog()[RENDER_CATALOG_KEY]?.probeRenderInputs || this.options.catalog()[NARRATED_CATALOG_KEY]?.probeRenderInputs
      || this.options.catalog()[TIMED_NARRATED_CATALOG_KEY]?.probeRenderInputs || this.options.catalog()["render:mixed_concat"]?.probeRenderInputs) {
      if (!this.options.production) throw new AgentError("CAPABILITY_UNAVAILABLE", "本地渲染能力未正确装配，不能准备这份提案。");
      probes = await probeRenderInputs(this.options.db, this.options.production.blobs, { ownerId, conversationId }, input.spec);
    }
    const result = this.options.db.transaction(() => {
      const replay = checkCommandReceipt<Proposal>(this.options.db, key, input);
      if (replay.kind === "replay") return { proposal: replay.receipt, replayed: true };
      // HTTP 没有在途 Pi 请求：按纯命令记法预生成一对真实闭合的请求与系统通知作为
      // requestSource 事实（requests.message_id 非空，与 Pi 路径同形），不排队、不进文本模型。
      const now = this.options.clock(), requestId = newAgentId("req"), messageId = newAgentId("msg");
      const { proposal } = applyPrepareProposal(this.options.db, now, {
        ownerId, conversationId,
      }, input.spec, this.options.catalog(), { requestId, messageId }, probes, input.replacesProposal);
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId,
        role: "system_notice", kind: "notice", state: "completed",
        text: `已通过接口准备提案“${input.spec.title}”。`,
        target: null, createdSeq: nextSeq(this.options.db, "messages", conversationId),
        references: { ...emptyReferences(), proposalIds: [proposal.id] },
      });
      insertQueuedRequest(this.options.db, now, {
        id: requestId, conversationId, ownerId, commandId: input.commandId, text: "",
        target: null, skillId: null, modelId: null,
        queueSeq: nextQueueSeq(this.options.db, conversationId), messageId,
      });
      this.options.db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(requestId);
      const payload = rowToProposal(proposal, this.options.db, this.options.catalog());
      storeCommandReceipt(this.options.db, now, key, input, payload);
      touchConversation(this.options.db, now, conversationId);
      return { proposal: payload, replayed: false };
    })();
    this.options.hub.notifyCommitted(conversationId);
    return { status: 201, ...result };
  }

  readProposal(ownerId: string, proposalId: string): Proposal {
    const row = getProposalRow(this.options.db, ownerId, proposalId);
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个提案。");
    return rowToProposal(row, this.options.db, this.options.catalog());
  }

  acceptProposal(ownerId: string, proposalId: string, input: AcceptProposal) {
    const verdict = validatorFor("AcceptProposal")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    if (!getProposalRow(this.options.db, ownerId, proposalId)) {
      throw new AgentError("NOT_FOUND", "没有找到这个提案。");
    }
    if (this.options.production) return this.options.production.accept(ownerId, proposalId, input);
    throw new AgentError("CAPABILITY_UNAVAILABLE", "制作能力尚未接入，暂不能受理这份提案。");
  }

  getRun(ownerId: string, runId: string) {
    if (this.options.production) return this.options.production.get(ownerId, runId);
    throw new AgentError("NOT_FOUND", "没有找到这个运行。");
  }

  cancelRun(ownerId: string, runId: string, input: CancelRun) {
    const verdict = validatorFor("CancelRun")(input);
    if (!verdict.ok) throw new AgentError("INVALID_INPUT", verdict.message);
    if (this.options.production) return this.options.production.cancel(ownerId, runId, input);
    throw new AgentError("NOT_FOUND", "没有找到这个运行。");
  }

  readBlob(ownerId: string, blobId: string) {
    if (this.options.production) {
      const blob = this.options.production.blobs.get(ownerId, blobId);
      return { ...blob, path: this.options.production.blobs.filePath(blob.digest) };
    }
    throw new AgentError("NOT_FOUND", "没有找到这个媒体对象。");
  }

  // —— 事件（SSE 数据源）——

  eventsAfter(ownerId: string, conversationId: string, cursor: string, limit = 200) {
    requireConversation(this.options.db, ownerId, conversationId);
    const afterSeq = decodeEventCursor(cursor, conversationId);
    const rows = readEventsAfter(this.options.db, conversationId, afterSeq, limit);
    const lastRow = rows.length > 0 ? rows[rows.length - 1]! : null;
    return {
      events: rows.map(row => toBusinessEventPayload(row, encodeEventCursor(conversationId, row.seq))),
      nextCursor: encodeEventCursor(conversationId, lastRow ? lastRow.seq : afterSeq),
    };
  }

  hub(): EventHub {
    return this.options.hub;
  }

  // SSE 与后台任务需要的只读数据库句柄。
  database(): AgentDatabase {
    return this.options.db;
  }

  // —— 后台与生命周期 ——

  startBackground(): void {
    if (this.sweepTimer) return;
    const invalidated = this.options.db.transaction(() => invalidateLegacyNarrationProposals(this.options.db, this.options.clock()))();
    for (const row of invalidated) this.options.hub.notifyCommitted(row.conversationId);
    this.sweepProposals();
    this.sweepTimer = setInterval(() => this.sweepProposals(), 60_000);
    this.sweepTimer.unref();
  }

  sweepProposals(): void {
    const touched = this.options.db.transaction(() =>
      sweepExpiredProposals(this.options.db, this.options.clock()))();
    for (const row of touched) this.options.hub.notifyCommitted(row.conversationId);
  }

  recover(): string[] {
    const interrupted = recoverInterruptedRequests(this.options.db, this.options.clock);
    this.options.registry.kickAllWithQueued();
    return interrupted;
  }

  async close(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.options.registry.close();
    this.options.hub.close();
    this.options.host.dispose();
  }

  // —— 内部 ——

  private visibleProposal(ownerId: string, ref: ProposalRef): Proposal {
    const row = getProposalRow(this.options.db, ownerId, ref.proposalId);
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个提案。");
    if (row.digest !== ref.digest) throw new AgentError("INVALID_INPUT", "提案摘要不一致，请重新读取提案。");
    return rowToProposal(row, this.options.db, this.options.catalog());
  }

  private requireTarget(ownerId: string, conversationId: string, target: Target): void {
    const artifact = getArtifactRow(this.options.db, ownerId, target.artifactId);
    const revision = artifact ? getRevisionRow(this.options.db, target.artifactId, target.revisionId) : undefined;
    if (!artifact || !revision || artifact.conversation_id !== conversationId) {
      throw new AgentError("NOT_FOUND", "目标产物或修订不存在。");
    }
    // 指向片段的入口核对（B2.5）：运行属于当前会话与同一视频事项，且片段真实存在于该运行的片段投影。
    if (target.segment) {
      const run = getScopedRunRow(this.options.db, ownerId, conversationId, target.segment.runId);
      if (!run) throw new AgentError("NOT_FOUND", "目标片段所属的运行不存在。");
      if (run.work_id !== target.workId) throw new AgentError("INVALID_INPUT", "目标片段属于其他视频事项。");
      if (!runSegments(this.options.db, run).some(segment => segment.segmentId === target.segment!.segmentId)) {
        throw new AgentError("INVALID_INPUT", "目标片段不在这份运行的片段列表里；请选择当前存在的片段。");
      }
    }
  }
}

function boundedPageSize(limit: number | undefined): number {
  if (limit === undefined) return PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
    throw new AgentError("INVALID_INPUT", `limit 必须在 1..${PAGE_SIZE} 之间。`);
  }
  return limit;
}

// 超取一行判断是否还有下一页；nextCursor 指向返回页最后一项的不可变创建序。
function pageCursor(
  fetched: { created_seq: number }[],
  pageSize: number,
  scope: { v: 1; c: string; k: string; w: number },
): string | null {
  if (fetched.length <= pageSize || fetched.length === 0) return null;
  return encodeListCursor({ ...scope, p: fetched[pageSize - 1]!.created_seq });
}

// 作品库投影行：确认表按 rowid（首次定稿位置）倒序去重后的最小行。
interface LibraryConfirmationRow {
  src: number;
  pos: number;
  conversation_id: string;
  work_id: string;
  subject_json: string;
  source_id: string;
  created_at: string;
}

function sameTarget(left: Target, right: Target): boolean {
  return left.artifactId === right.artifactId && left.revisionId === right.revisionId;
}
