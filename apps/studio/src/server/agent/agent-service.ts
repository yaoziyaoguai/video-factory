import { readProviderConnections, saveProviderConnection, listAvailableProviderModels } from "./provider-connections.js";
import type {
  AcceptProposal, ArtifactHead, ArtifactRevision, Bootstrap, CancelRun, Conversation, ConversationPage,
  ContentSource, CreateConversation, FeedbackInput, FeedbackReceipt, LibraryVideo, LibraryVideoPage, Message,
  MessageInput, MessagePage, MessageReferences, ModelBinding, Proposal, ProposalPage, RenameConversation,
  RequestReceipt, RevisionRef, RunPage, Snapshot, StopRequest, Target,
  PrepareProposal, ProposalRef, SaveUserProfile, SaveUserProfileReceipt, UserProfile, Work, MaterialBatch,
  FreeServiceSettings, SaveFreeServiceSettingsReceipt, ImportedSettings, ProductionSpec,
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
  feedbackNote, getArtifactRow, getProposalRow, getRevisionRow, listArtifactRows, listProposalRows,
  maxArtifactSeq, maxProposalSeq, rowToArtifactHead, rowToArtifactRevision, rowToProposal, productionAudioFacts,
  applyPrepareProposal, sweepExpiredProposals, invalidateLegacyNarrationProposals, hasProductionLock, NARRATED_CATALOG_KEY, RENDER_CATALOG_KEY, TIMED_NARRATED_CATALOG_KEY,
  type QuoteCatalog, type RenderFileProbe,
} from "./artifact-store.js";
import { probeRenderInputs } from "./media-probe.js";
import { getWorkRow, hasPlanDraftForContent, listWorkRows, recordStageConfirmation, requireWork, workProjection } from "./creative-work.js";
import { listMaterialBatches, readMaterialBatch as readMaterialBatchRow } from "./material-store.js";
import { ConversationRunnerRegistry, recoverInterruptedRequests } from "./executor.js";
import type { PiRuntimeHost } from "./pi-runtime.js";
import type { SkillPackages } from "./skill-packages.js";
import type { CrashPointHook } from "./pi-tools.js";
import type { ProductionService } from "./production-service.js";
import { readUserProfile, saveUserProfile as saveUserProfileRow } from "./text-model-settings.js";
import {
  freeServiceIdOf, readFreeServiceSettings, saveKeyedServiceSettings, saveKeylessServiceSettings, saveNewsNowServiceSettings,
} from "./free-service-settings.js";
import type { SaveKeylessServiceSettings, SaveNewsNowSettings, SavePexelsSettings } from "../../shared/agent/generated/contracts.js";
import { toRun, runSegments, type RunRow } from "./production-store.js";
import { getScopedRunRow } from "./production-index.js";

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
  // 首次定稿时间（确认 rowid）倒序 + revisionId 稳定排序；重复定稿不把旧作品顶到最前。
  listLibraryVideos(ownerId: string, cursor: string | undefined, limit: number | undefined): LibraryVideoPage {
    const pageSize = boundedPageSize(limit);
    const beforePos = cursor === undefined ? undefined : decodeListCursor(cursor, ownerId, "library").p;
    const db = this.options.db;
    const fetched = db.prepare(`
      SELECT fc.rowid AS pos, fc.conversation_id AS conversation_id, fc.work_id AS work_id,
             fc.subject_json AS subject_json, fc.created_at AS created_at
      FROM work_stage_confirmations fc
      WHERE fc.owner_id = ? AND fc.action = 'finalize_video'
        AND fc.rowid = (SELECT MIN(f2.rowid) FROM work_stage_confirmations f2
                        WHERE f2.owner_id = fc.owner_id AND f2.action = 'finalize_video'
                          AND json_extract(f2.subject_json, '$.revisionId') = json_extract(fc.subject_json, '$.revisionId'))
        AND (? IS NULL OR fc.rowid < ?)
      ORDER BY fc.rowid DESC
      LIMIT ?`).all(ownerId, beforePos ?? null, beforePos ?? null, pageSize + 1) as LibraryConfirmationRow[];
    const items = fetched.slice(0, pageSize)
      .map(row => this.libraryVideoEntry(ownerId, row))
      .filter((entry): entry is LibraryVideo => entry !== null);
    return {
      items,
      nextCursor: fetched.length > pageSize
        ? encodeListCursor({ v: 1, c: ownerId, k: "library", p: fetched[pageSize - 1]!.pos, w: 0 })
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
    if (revision.run_id) {
      const run = db.prepare("SELECT id, rowid AS run_order, proposal_id, snapshot_id FROM production_runs WHERE id = ? AND owner_id = ?")
        .get(revision.run_id, ownerId) as { id: string; run_order: number; proposal_id: string; snapshot_id: string } | undefined;
      if (run) {
        const snapshot = db.prepare("SELECT spec_json FROM production_snapshots WHERE id = ?").get(run.snapshot_id) as { spec_json: string };
        const audio = productionAudioFacts(db, JSON.parse(snapshot.spec_json) as ProductionSpec, run.run_order);
        narrationText = audio.narrationText;
        audioSummary = audio.audioSummary;
        const proposal = getProposalRow(db, ownerId, run.proposal_id);
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
    return {
      video: { artifactId: subject.artifactId, revisionId: subject.revisionId },
      workId: row.work_id, conversationId: row.conversation_id, title: artifact.title,
      finalizedAt: row.created_at, plan, content, originMessageId, narrationText, ...(audioSummary ? { audioSummary } : {}),
    };
  }

  private artifactPage(ownerId: string, conversationId: string, cursor: string | undefined, pageSize: number) {
    void ownerId;
    const beforeSeq = cursor === undefined ? undefined : decodeListCursor(cursor, conversationId, "artifacts").p;
    const fetched = listArtifactRows(this.options.db, conversationId, pageSize + 1, beforeSeq);
    const rows = fetched.slice(0, pageSize);
    const watermark = cursor === undefined ? maxEventSeq(this.options.db, conversationId) : decodeListCursor(cursor, conversationId, "artifacts").w;
    return {
      items: rows.map(rowToArtifactHead),
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
      items: rows.map(row => rowToProposal(row, this.options.db)),
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

    // 结构化阶段认可来自按钮的真实动作，先于普通发送；纯认可不需要文本模型，也不受技能刷新影响。
    if (input.stageConfirmation) return this.sendStageConfirmation(ownerId, conversationId, input);

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

  // 结构化阶段认可（按钮）：纯认可在接收事务里直接完成，不进 Pi；“内容认可并继续”与
  // “方案认可并准备制作”在同一事务写入认可并排入一次现有队列请求；后者的请求 target
  // 指向这份准确方案修订。内容“继续”若已有准确以本次内容为来源的方案草稿，只补记认可
  // 并展示它，不依赖文本模型或新请求。失败整体回滚，不留半份认可或队列。
  private sendStageConfirmation(ownerId: string, conversationId: string, input: MessageInput): { status: 202; receipt: RequestReceipt } {
    const confirmation = input.stageConfirmation!;
    const prepares = confirmation.action === "approve_plan" && confirmation.next === "prepare_production";
    // 决策在事务外读取：方案草稿只前进不回退，不存在核对与记录间的半写状态。
    const continuesWithoutRequest = confirmation.action === "approve_content_continue"
      && hasPlanDraftForContent(this.options.db, { ownerId, conversationId }, confirmation.workId, confirmation.subject);
    const queues = (confirmation.action === "approve_content_continue" && !continuesWithoutRequest) || prepares;
    if (queues) this.options.skillPackages?.resources();
    const receipt = this.options.db.transaction(() => {
      // 文本模型只在需要排 Pi 请求时需要；纯认可即使没有可用文本模型也能完成。
      const binding = queues ? this.options.defaultTextBinding() : null;
      if (queues && !binding) throw new AgentError("CAPABILITY_UNAVAILABLE", confirmation.action === "approve_content_continue" ? "尚未配置可用的文本模型，暂不能继续画面阶段；认可未写入。" : "尚未配置可用的文本模型，暂不能准备制作；认可未写入。");
      if (queues && pendingRequestCount(this.options.db, conversationId) >= QUEUE_LIMIT) {
        throw new AgentError("QUEUE_FULL", "本会话待处理消息已达上限，请等待当前回合完成。");
      }
      if (queues && input.skillId && !this.options.skills().some(skill => skill.id === input.skillId)) {
        throw new AgentError("INVALID_INPUT", "未安装这个技能。");
      }
      const now = this.options.clock(), requestId = newAgentId("req"), messageId = newAgentId("msg");
      const subject = confirmation.subject;
      // 准备制作的请求 target 就是这份准确方案修订；其合法性由下方 recordStageConfirmation 在同事务复核。
      const requestTarget: Target | null = prepares && subject.kind === "artifact_revision"
        ? { artifactId: subject.artifactId, revisionId: subject.revisionId, workId: confirmation.workId }
        : null;
      const references: MessageReferences = {
        ...emptyReferences(),
        artifacts: subject.kind === "artifact_revision"
          ? [{ artifactId: subject.artifactId, revisionId: subject.revisionId }] : [],
      };
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId, role: "user", kind: "chat",
        state: queues ? "queued" : "completed", text: input.text,
        target: prepares ? requestTarget : null,
        createdSeq: nextSeq(this.options.db, "messages", conversationId), references,
      });
      insertQueuedRequest(this.options.db, now, {
        id: requestId, conversationId, ownerId, commandId: input.commandId, text: input.text,
        target: requestTarget, skillId: queues ? input.skillId : null, modelId: binding?.modelId ?? null,
        queueSeq: nextQueueSeq(this.options.db, conversationId), messageId,
      });
      if (binding) this.options.db.prepare("UPDATE requests SET model_binding_json=? WHERE id=?").run(JSON.stringify(binding), requestId);
      else this.options.db.prepare("UPDATE requests SET state='completed', delivery_closed=1 WHERE id=?").run(requestId);
      recordStageConfirmation(this.options.db, now, { ownerId, conversationId }, {
        workId: confirmation.workId, action: confirmation.action, subject,
        sourceKind: "user_message", sourceId: messageId,
      });
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
      insertMessage(this.options.db, now, {
        id: messageId, conversationId, ownerId, requestId,
        role: "user", kind: "chat", state: "queued", text: input.text, target: input.target,
        createdSeq: nextSeq(this.options.db, "messages", conversationId), references,
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
    return rowToArtifactHead(row);
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
      const note = hasProductionLock(this.options.db, input.target.artifactId) ? feedbackNote("next_version") : feedbackNote();
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
      const { proposal } = applyPrepareProposal(this.options.db, this.options.clock(), {
        ownerId, conversationId,
      }, input.spec, this.options.catalog(), probes, input.planSource, input.replacesProposal);
      const payload = rowToProposal(proposal, this.options.db);
      storeCommandReceipt(this.options.db, this.options.clock(), key, input, payload);
      return { proposal: payload, replayed: false };
    })();
    this.options.hub.notifyCommitted(conversationId);
    return { status: 201, ...result };
  }

  readProposal(ownerId: string, proposalId: string): Proposal {
    const row = getProposalRow(this.options.db, ownerId, proposalId);
    if (!row) throw new AgentError("NOT_FOUND", "没有找到这个提案。");
    return rowToProposal(row, this.options.db);
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
    return rowToProposal(row, this.options.db);
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
  pos: number;
  conversation_id: string;
  work_id: string;
  subject_json: string;
  created_at: string;
}

function sameTarget(left: Target, right: Target): boolean {
  return left.artifactId === right.artifactId && left.revisionId === right.revisionId;
}
