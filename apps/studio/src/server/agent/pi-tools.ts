import { VIDEO_TOPIC_CHARTS } from "../../shared/agent/video-topics.js";
import { formatDimensionNote, resizeImage, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { contractsSchema } from "../../shared/agent/generated/contracts-schema.js";
import type {
  ArtifactRevision, ContentSource, DeliveryReceipt, MaterialBatch, MaterialImportResult, MaterialSearchResult, MediaContent, OperationRequest,
  ProductionIntent, Proposal, Target, ToolConfirmReview, ToolDelivery, ToolImportMaterial, ToolPrepareProposal,
  ToolReadArtifact, ToolReadMaterialBatch, ToolReadProposal, ToolReadRun, ToolReadWork, ToolRecordWorkFeedback,
  ToolReadTrends, ToolSearchMaterials, ToolStartWork, ToolListProduction, ProductionIndexPage, Run, TrendReadResult,
  TrendSnapshot, FeedbackReceipt, Work, ToolPublishProject, ToolRenderProject, LocalCreationReceipt,
  CreativeProjectContent, ProjectFile, FileContent,
  ToolDubFree, DubFreeResult, SpeechBoundary, DubbedSpeechMeta,
} from "../../shared/agent/generated/contracts.js";
import type { PiBusinessTools, RequestContext, WorkFeedbackView, WorkWithFeedback } from "../../shared/agent/ports.js";
import type { AgentDatabase } from "./db.js";
import { AgentError, AgentToolError } from "./errors.js";
import {
  applyDelivery, applyPrepareProposal, commitInvocationResult, deliveryDigest, getArtifactRow, getInvocation, getRevisionRow,
  insertRevision, registerInvocation, rowToArtifactRevision, rowToProposal, hasProductionLock,
  NARRATED_CATALOG_KEY, RENDER_CATALOG_KEY, TIMED_NARRATED_CATALOG_KEY,
  type ArtifactRow, type ProposalRow, type QuoteCatalog, type RenderFileProbe,
} from "./artifact-store.js";
import { extractVideoFrames, probeAudioFile, probeRenderInputs, probeVideoFile, InvalidAudioFile, type VideoFileFacts } from "./media-probe.js";
import { captureEdgeTtsConfig, captureNewsNowConfig, captureStockConfigs, FREE_SERVICE_LABELS, readFreeServiceSettings } from "./free-service-settings.js";
import { insertEvent } from "./event-log.js";
import { importMaterial, persistSearchBatch, readMaterialBatch } from "./material-store.js";
import {
  createWork, parseCreationState, recordReviewConfirmation, relatedWorkFeedback,
  requireWork, workInFlight, workProjection,
} from "./creative-work.js";
import type { CreativeRunner, CreativeWorkspace } from "./creative-runner.js";
import type { ProductionService } from "./production-service.js";
import { readMusicChart } from "./music-charts.js";
import { NewsNowClient } from "./newsnow-client.js";
import { StockClient, type StockCandidateInput } from "./stock-providers.js";
import { StockKindUnsupportedError, StockUnavailableError } from "./stock-http.js";
import { getScopedProposal, getScopedRunRow, listProductionIndex } from "./production-index.js";
import { toRun, runSegments } from "./production-store.js";
import { getMessageRow, getRequestRow, nextSeq, saveAssistantMessage, type RequestRow } from "./conversation-store.js";
import { digestOf, newAgentId, type AgentClock } from "./util.js";

// Pi 工具层：业务函数实现 ports.PiBusinessTools（可直接被测试重放），
// Pi SDK 按 ToolDefinition 的 canonical Schema 校验参数；包装器只注入当前请求上下文。
// 上下文不是权限证明：所有可变操作在事务内复核请求状态、epoch 与归属。

export type CrashPointHook = (point: string) => void;

/** 素材/资讯通道的工作事实；测试可注入替身 fetch，缺省走真实网络（NewsNow 一律真实 fetch 指向本地桩）。 */
export interface MaterialToolsOptions {
  workRoot: string;
  stockFetch?: typeof fetch;
  /** Pixabay 响应缓存目录（服务条款要求缓存 24h）；null 表示不缓存。 */
  cacheRoot?: string | null;
}

/** 隔离创作环境的宿主接线：读取工程文件与运行镜像都经同一 CreativeRunner。 */
export interface CreativeToolsOptions {
  runner: CreativeRunner;
  /** 当前明确作品的编辑工作区身份；与原生创作工具同一来源，不由模型自选。 */
  workspace: (conversationId: string, workId: string) => CreativeWorkspace;
}

const noopCrashPoint: CrashPointHook = () => {};

// 工具输入的薄转换：模型只表达创作需要（操作、输入、参数、授权金额），
// 固定创建次数来自当前通道目录，不接受模型自选；内部 intent 仍是完整字段。
export function expandToolIntent(
  intent: import("../../shared/agent/generated/contracts.js").ToolProductionIntent,
  catalog: QuoteCatalog,
): ProductionIntent {
  return {
    ...intent,
    operations: intent.operations.map((op): OperationRequest => {
      const key = op.kind === "render" ? `render:${op.parameters.assembly}` : `${op.kind}:${op.model.modelId}`;
      const attempts = catalog[key]?.maxCreateAttempts ?? 1;
      if (op.kind === "render") return { ...op, maxCreateAttempts: 1 };
      if (attempts !== 1 && attempts !== 2 && attempts !== 3) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "该通道的创建次数配置不可用，不能准备提案。");
      return { ...op, maxCreateAttempts: attempts };
    }) as [OperationRequest, ...OperationRequest[]],
  };
}

function requestContext(context: {
  actorId: string; conversationId: string; requestId: string; executionEpoch: number; target: Target | null;
  toolCallId: string; actionSourceMessageId: string;
}): RequestContext {
  // 品牌类型只约束编译期；持久事实的核对在各业务事务内进行。
  return context as unknown as RequestContext;
}

export class BusinessTools implements PiBusinessTools {
  constructor(
    private readonly db: AgentDatabase,
    private readonly clock: AgentClock,
    private readonly catalog: () => QuoteCatalog,
    private readonly crashPoint: CrashPointHook = noopCrashPoint,
    /** 仅用于付费前的渲染输入文件探测；无 render 能力时可为空。 */
    private readonly blobs?: import("./production-blobs.js").ProductionBlobs,
    /** 素材/资讯工具的下载目录与替身 fetch；缺省时采用类工具不可用。 */
    private readonly materials?: MaterialToolsOptions,
    /** 免费本地渲染受理；缺省时 render_project 不可用。 */
    private readonly production?: ProductionService,
    /** 工程封存（publish_project）；缺省时该工具不可用。 */
    private readonly creative?: CreativeToolsOptions,
  ) {}

  async readArtifact(context: RequestContext, input: ToolReadArtifact): Promise<ArtifactRevision> {
    const load = this.db.transaction((): ArtifactRevision => {
      const artifact = this.db.prepare("SELECT id FROM artifacts WHERE id = ? AND conversation_id = ? AND owner_id = ?")
        .get(input.artifactId, context.conversationId, context.actorId);
      const revision = artifact ? getRevisionRow(this.db, input.artifactId, input.revisionId) : undefined;
      if (!artifact || !revision) throw new AgentError("NOT_FOUND", "没有找到这个产物修订。");
      return rowToArtifactRevision(revision);
    });
    return load();
  }

  async readProposal(context: RequestContext, input: ToolReadProposal): Promise<Proposal> {
    this.requireRunningRequest(context);
    const proposal = getScopedProposal(this.db, context.actorId, context.conversationId, input.proposalId, this.catalog());
    if (!proposal) throw new AgentError("NOT_FOUND", "当前会话中没有这个提案。");
    return proposal;
  }

  async readRun(context: RequestContext, input: ToolReadRun): Promise<Run> {
    this.requireRunningRequest(context);
    const row = getScopedRunRow(this.db, context.actorId, context.conversationId, input.runId);
    if (!row) throw new AgentError("NOT_FOUND", "当前会话中没有这个制作运行。");
    return toRun(this.db, row);
  }

  async listProduction(context: RequestContext, input: ToolListProduction): Promise<ProductionIndexPage> {
    this.requireRunningRequest(context);
    return listProductionIndex(this.db, context.conversationId, input);
  }

  async searchMaterials(context: RequestContext, input: ToolSearchMaterials, signal?: AbortSignal): Promise<MaterialSearchResult> {
    this.requireRunningRequest(context);
    // 关联正式事项时核对归属；新组模型不再有固定阶段门槛，素材选择本身也不构成认可依据。
    const workId = input.workId ?? null;
    if (workId) requireWork(this.db, context.actorId, context.conversationId, workId);
    // 省略 provider 时用默认来源；调用开始时捕获配置，本次请求内不受后续设置修改影响。
    const client = this.stockClient();
    const provider = input.provider ?? (input.kind === "audio" ? client.enabledServices().find(service => service.kinds.includes("audio"))?.serviceId : "pexels");
    if (!provider) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "没有已启用的音乐素材来源；请在免费服务的音乐素材中查看配置。");
    let found: StockCandidateInput[];
    try {
      found = await client.search(provider, {
        query: input.query, kind: input.kind, limit: input.limit, newCandidateId: () => newAgentId("cand"),
      }, signal);
    } catch (error) {
      if (error instanceof StockKindUnsupportedError) throw new AgentToolError("INVALID_INPUT", error.message);
      if (error instanceof StockUnavailableError) {
        throw new AgentToolError(client.ready(provider) ? "TEMPORARILY_UNAVAILABLE" : "CAPABILITY_UNAVAILABLE", error.message);
      }
      throw error;
    }
    // 网络返回后的事实复核：保存候选前确认同一请求仍在运行、同 epoch。
    const persist = this.db.transaction((): MaterialSearchResult => {
      this.requireRunningRequest(context);
      if (workId) requireWork(this.db, context.actorId, context.conversationId, workId);
      const { batch, results } = persistSearchBatch(this.db, this.clock, {
        ownerId: context.actorId, conversationId: context.conversationId, requestId: context.requestId,
      }, { query: { provider, kind: input.kind, query: input.query, limit: input.limit }, toolCallId: context.toolCallId, workId }, found);
      return { batchId: batch.batchId, results, retrievedAt: batch.retrievedAt };
    });
    return persist();
  }

  /** 免费素材客户端：构造时捕获全部来源配置，本请求内不受后续设置修改影响。 */
  private stockClient(): StockClient {
    return new StockClient(captureStockConfigs(this.db), this.materials?.stockFetch, this.materials?.cacheRoot ?? null);
  }

  async readMaterialBatch(context: RequestContext, input: ToolReadMaterialBatch): Promise<MaterialBatch> {
    this.requireRunningRequest(context);
    const batch = readMaterialBatch(this.db, context.actorId, input.batchId);
    if (!batch) throw new AgentError("NOT_FOUND", "没有找到这个素材批次。");
    const owned = this.db.prepare("SELECT conversation_id FROM material_search_batches WHERE id=?").get(input.batchId) as { conversation_id: string };
    if (owned.conversation_id !== context.conversationId) throw new AgentError("NOT_FOUND", "没有找到这个素材批次。");
    return batch;
  }

  async startWork(context: RequestContext, input: ToolStartWork): Promise<Work> {
    const title = input.title.trim();
    if (!title) throw new AgentToolError("INVALID_INPUT", "视频标题不能为空。");
    const write = this.db.transaction(() => {
      this.requireRunningRequest(context);
      const row = createWork(this.db, this.clock(), { ownerId: context.actorId, conversationId: context.conversationId }, title);
      return workProjection(this.db, row);
    });
    return write();
  }

  async readWork(context: RequestContext, input: ToolReadWork): Promise<WorkWithFeedback> {
    this.requireRunningRequest(context);
    const work = requireWork(this.db, context.actorId, context.conversationId, input.workId);
    const projection = workProjection(this.db, work);
    // 与 executor 上下文共用同一只读查询：无 UI target 时模型仍能读到该视频的相关意见。
    const artifactIds = projection.reviewGroups
      .flatMap(group => group.items)
      .flatMap(item => [item.draft, item.approved])
      .flatMap(source => source?.kind === "artifact_revision" ? [source.artifactId] : []);
    return { ...projection, relatedFeedback: relatedWorkFeedback(this.db, context.conversationId, { workIds: [work.id], artifactIds }) };
  }

  // 普通认可只记录用户已经表达的事实；不推进未要求的下一组工作，也不能在这里受理制作。
  async confirmReview(context: RequestContext, input: ToolConfirmReview): Promise<Work> {
    const write = this.db.transaction(() => {
      this.requireRunningRequest(context);
      const { work } = recordReviewConfirmation(this.db, this.clock(), {
        ownerId: context.actorId, conversationId: context.conversationId,
      }, {
        workId: input.workId, groupId: input.groupId, items: input.items, action: input.action,
      }, { kind: "user_message", messageId: context.actionSourceMessageId });
      return workProjection(this.db, work);
    });
    return write();
  }

  // 复用既有消息反馈关联：宿主取当前真实用户消息，补 target/references/feedback 并升版；
  // 不改原文、不插入重复用户发言、不改正在执行的请求状态。
  // 意见对象二选一：显式稿件修订；或两个坐标均为 null 时该事项当前内容稿——内容为聊天原文时按
  // work + 有限内容来源关联，不复制稿件、不伪造 artifact ID。
  async recordWorkFeedback(context: RequestContext, input: ToolRecordWorkFeedback): Promise<FeedbackReceipt> {
    const write = this.db.transaction((): FeedbackReceipt => {
      this.requireRunningRequest(context);
      const work = requireWork(this.db, context.actorId, context.conversationId, input.workId);
      const message = getMessageRow(this.db, context.actorId, context.actionSourceMessageId);
      if (!message || message.conversation_id !== context.conversationId) throw new AgentError("NOT_FOUND", "没有找到本次用户消息。");
      const state = parseCreationState(work);
      const items = state.groups.flatMap(group => group.items);
      // 内容主稿：最近的内容角色事项当前稿（与视频产出归属的解析方向一致）。
      const contentDraft = [...items].reverse().find(item => item.role === "content")?.draft ?? null;
      let target: Target | null = null;
      let contentSource: ContentSource | null = null;
      // 制作在途时，对该事项的意见都属于下一版；不在途时再看具体稿件是否被锁。
      let nextVersion = workInFlight(this.db, work.id);
      if (input.artifactId !== null) {
        const artifact = this.db.prepare("SELECT id, head_revision_id FROM artifacts WHERE id=? AND owner_id=? AND conversation_id=?")
          .get(input.artifactId, context.actorId, context.conversationId) as { id: string; head_revision_id: string | null } | undefined;
        if (!artifact || artifact.head_revision_id !== input.baseRevisionId) {
          throw new AgentError("STALE_REVISION", "这份稿件已更新，请基于当前版本提出意见。");
        }
        // 意见只能指向本事项的真实主稿，不能把 A 的意见挂到 B。
        const bound = this.db.prepare("SELECT creation_binding_json FROM artifact_revisions WHERE artifact_id=? AND id=?")
          .get(input.artifactId, input.baseRevisionId) as { creation_binding_json: string | null } | undefined;
        const binding = bound?.creation_binding_json ? JSON.parse(bound.creation_binding_json) as { workId: string } : null;
        if (binding && binding.workId !== work.id) throw new AgentError("INVALID_INPUT", "这份稿件属于其他视频创作。");
        if (!binding && !items.some(item =>
          [item.draft, item.approved].some(source => source?.kind === "artifact_revision" && source.artifactId === input.artifactId))) {
          throw new AgentError("INVALID_INPUT", "这份稿件不属于该视频的主稿。");
        }
        target = { artifactId: input.artifactId, revisionId: input.baseRevisionId!, workId: work.id };
        nextVersion = nextVersion || hasProductionLock(this.db, input.artifactId);
      } else if (contentDraft?.kind === "artifact_revision") {
        target = { artifactId: contentDraft.artifactId, revisionId: contentDraft.revisionId, workId: work.id };
        nextVersion = nextVersion || hasProductionLock(this.db, contentDraft.artifactId);
      } else if (contentDraft?.kind === "message_text") {
        contentSource = contentDraft;
      } else {
        throw new AgentError("INVALID_INPUT", "这条视频还没有内容主稿，没有可挂意见的对象。");
      }
      // 指向片段的意见（B1）：入口核对运行归属、事项一致与片段真实存在，随后并入 target 持久化。
      if (input.segment) {
        const run = getScopedRunRow(this.db, context.actorId, context.conversationId, input.segment.runId);
        if (!run) throw new AgentError("NOT_FOUND", "意见指向的片段所属运行不存在。");
        if (run.work_id !== work.id) throw new AgentError("INVALID_INPUT", "意见指向的片段属于其他视频事项。");
        if (!runSegments(this.db, run).some(segment => segment.segmentId === input.segment!.segmentId)) {
          throw new AgentError("INVALID_INPUT", "意见指向的片段不在这份运行的片段列表里；不能引用不存在的片段。");
        }
        if (!target) throw new AgentError("INVALID_INPUT", "指向片段的意见需要落在具体主稿上；内容为聊天原文时先让用户采用为稿件，或就整体提出意见。");
        target.segment = { runId: input.segment.runId, segmentId: input.segment.segmentId };
      }
      const note = {
        applied: false as const,
        disposition: nextVersion ? "next_version" as const : "noted" as const,
        workId: contentSource ? work.id : null,
        contentSource,
      };
      const references = JSON.parse(message.references_json) as { artifacts?: unknown[]; proposalIds?: string[]; runIds?: string[]; materialBatchIds?: string[] };
      const revision = message.revision + 1;
      this.db.prepare("UPDATE messages SET target_json=?, references_json=?, feedback_json=?, revision=?, updated_at=? WHERE id=?")
        .run(target ? JSON.stringify(target) : null, JSON.stringify({
          artifacts: target ? [{ artifactId: target.artifactId, revisionId: target.revisionId }] : [],
          proposalIds: references.proposalIds ?? [], runIds: references.runIds ?? [],
          materialBatchIds: references.materialBatchIds ?? [],
        }), JSON.stringify(note), revision, this.clock(), message.id);
      insertEvent(this.db, this.clock(), {
        conversationId: context.conversationId, ownerId: context.actorId,
        kind: "message.changed", entityId: message.id, entityVersion: revision,
      });
      return {
        target, workId: note.workId, contentSource,
        applied: note.applied, disposition: note.disposition,
        replayed: false, messageId: message.id, messageRevision: revision,
      };
    });
    return write();
  }

  async readTrends(context: RequestContext, input: ToolReadTrends, signal?: AbortSignal): Promise<TrendReadResult> {
    this.requireRunningRequest(context);
    if (input.musicChart) {
      if (input.sourceIds) throw new AgentToolError("INVALID_INPUT", "平台热歌榜和 NewsNow 来源请分开读取。");
      if (!readFreeServiceSettings(this.db, input.musicChart).enabled) {
        throw new AgentToolError("CAPABILITY_UNAVAILABLE", `${FREE_SERVICE_LABELS[input.musicChart]}未启用，可在「免费服务 → 音乐素材」中打开。`);
      }
      const chart = await readMusicChart(input.musicChart, input.limit, this.materials?.stockFetch, signal);
      return { sources: [chart], retrievedAt: this.clock(), topics: [] };
    }
    const config = captureNewsNowConfig(this.db);
    if (!config) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "国内平台榜单未启用，可在「免费服务 → 视频选题」里配置。");
    // 提供的 sourceIds 只能是当前配置集合的非空子集；结果顺序沿选定集合。
    const selected = input.sourceIds ? config.sourceIds.filter(id => input.sourceIds!.includes(id)) : config.sourceIds;
    if (input.sourceIds && (selected.length !== input.sourceIds.length || selected.length === 0)) {
      throw new AgentToolError("INVALID_INPUT", "sourceIds 只能使用已配置来源中的非空子集。");
    }
    const client = new NewsNowClient(config);
    const sources = await client.readSources(selected, input.limit, signal);
    // selected 至少一个来源且每个来源都有快照（失败也是 unavailable 快照），元组非空成立。
    return { sources: sources as [TrendSnapshot, ...TrendSnapshot[]], retrievedAt: this.clock(), topics: config.topics };
  }

  async importMaterial(context: RequestContext, input: ToolImportMaterial, signal?: AbortSignal): Promise<MaterialImportResult> {
    const request = this.requireRunningRequest(context);
    if (request.delivery_closed) throw new AgentToolError("DELIVERY_CLOSED", "本请求已完成正式交付，不能继续采用素材。");
    if (input.workId) requireWork(this.db, context.actorId, context.conversationId, input.workId);
    if (!this.materials || !this.blobs) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "素材下载通道未装配。");
    return importMaterial(this.db, this.clock, this.blobs, this.materials.workRoot, this.stockClient(), {
      ownerId: context.actorId, conversationId: context.conversationId, requestId: context.requestId,
    }, { executionEpoch: context.executionEpoch }, input.candidateId, signal, input.usage);
  }

  async deliverArtifacts(context: RequestContext, input: ToolDelivery): Promise<DeliveryReceipt> {
    this.requireRequest(context);
    // 第一段短事务：调用登记（F7 回执窗口的起点）。
    const register = this.db.transaction(() =>
      registerInvocation(this.db, this.clock(), {
        ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
        toolName: "deliver_artifacts", args: input,
      }));
    register();

    // 同 toolCallId 已提交过：直接回放原回执，不第二次交付。
    const prior = getInvocation(this.db, context.actorId, context.requestId, context.toolCallId);
    if (prior?.state === "committed") {
      return { ...JSON.parse(prior.result_json!) as DeliveryReceipt, replayed: true };
    }

    const apply = this.db.transaction((): DeliveryReceipt => {
      const request = this.requireRequest(context);
      const delivered = this.db.prepare("SELECT batch_digest, receipt_json FROM request_deliveries WHERE request_id=?").get(request.id) as { batch_digest: string; receipt_json: string } | undefined;
      if (delivered) {
        // 完整参数摘要（items 与 reviewGroups）由交付事务与这里共用；仅改关联也必须拒绝。
        if (delivered.batch_digest !== deliveryDigest(input)) throw new AgentError("DELIVERY_CLOSED", "本请求已交付其他内容，请发起新请求。");
        const receipt = { ...JSON.parse(delivered.receipt_json) as DeliveryReceipt, replayed: true };
        commitInvocationResult(this.db, this.clock(), { ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId }, receipt);
        return receipt;
      }
      this.requireRunningRequest(context);
      const { receipt } = applyDelivery(this.db, this.clock(), { request, epoch: context.executionEpoch }, input);
      commitInvocationResult(this.db, this.clock(), {
        ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
      }, receipt);
      saveAssistantMessage(this.db, this.clock(), request, "", "running");
      return receipt;
    });
    const receipt = apply();
    // 业务事实已提交、Pi 会话历史尚未写入工具结果——F7 崩溃窗口。
    this.crashPoint("after-deliver-commit");
    return receipt;
  }

  async prepareProduction(context: RequestContext, input: ToolPrepareProposal): Promise<Proposal> {
    this.requireRequest(context);
    const register = this.db.transaction(() =>
      registerInvocation(this.db, this.clock(), {
        ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
        toolName: "prepare_production", args: input,
      }));
    register();

    const prior = getInvocation(this.db, context.actorId, context.requestId, context.toolCallId);
    if (prior?.state === "committed" && prior.proposal_id) {
      const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(prior.proposal_id) as ProposalRow | undefined;
      if (row) return rowToProposal(row, this.db, this.catalog());
    }
    // 仅宿主已确认的本次原生恢复可回放同规范化参数；正常请求仍可重新准备。
    const digestReplay = context.nativeRecovery ? this.db.prepare(
      "SELECT proposal_id FROM tool_invocations WHERE owner_id = ? AND request_id = ? AND tool_name = 'prepare_production' AND args_digest = ? AND state = 'committed' AND proposal_id IS NOT NULL ORDER BY rowid DESC LIMIT 1",
    ).get(context.actorId, context.requestId, digestOf(input)) as { proposal_id: string } | undefined : undefined;
    if (digestReplay) {
      const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(digestReplay.proposal_id) as ProposalRow | undefined;
      if (row) {
        this.db.transaction(() => commitInvocationResult(this.db, this.clock(), {
          ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
        }, { proposalId: row.id, digest: row.digest, state: row.state, expiresAt: row.expires_at }, row.id))();
        return rowToProposal(row, this.db, this.catalog());
      }
    }

    // 付费前探测：真实 render 目录（任一 assembly 分支）要求已有输入文件可读（事务外执行，结果随校验上下文进入事务）。
    const catalog = this.catalog();
    const intent = expandToolIntent(input.spec, catalog);
    let probes: Map<string, RenderFileProbe> | undefined;
    if (catalog[RENDER_CATALOG_KEY]?.probeRenderInputs || catalog[NARRATED_CATALOG_KEY]?.probeRenderInputs
      || catalog[TIMED_NARRATED_CATALOG_KEY]?.probeRenderInputs || catalog["render:mixed_concat"]?.probeRenderInputs) {
      if (!this.blobs) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "本地渲染能力未正确装配，不能准备这份提案。");
      probes = await probeRenderInputs(this.db, this.blobs, { ownerId: context.actorId, conversationId: context.conversationId }, intent);
    }

    const apply = this.db.transaction((): Proposal => {
      const request = this.requireRunningRequest(context);
      if (request.delivery_closed) {
        // A-18：交付关闭本请求的一切变更出口，提案也不例外。
        throw new AgentError("DELIVERY_CLOSED", "本请求已完成正式交付，不能在同一请求里再准备提案。");
      }
      const { proposal } = applyPrepareProposal(this.db, this.clock(), {
        ownerId: context.actorId, conversationId: context.conversationId,
      }, intent, catalog, { requestId: context.requestId, messageId: context.actionSourceMessageId }, probes, input.replacesProposal);
      const result = { proposalId: proposal.id, digest: proposal.digest, state: proposal.state, expiresAt: proposal.expires_at };
      commitInvocationResult(this.db, this.clock(), {
        ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
      }, result, proposal.id);
      saveAssistantMessage(this.db, this.clock(), request, "", "running");
      return rowToProposal(proposal, this.db, this.catalog());
    });
    const proposal = apply();
    this.crashPoint("after-prepare-commit");
    return proposal;
  }

  // 工程封存（publish_project）：把当前工程选定文件与入口冻结为 project 修订。
  // 只封存，不认可、不受理制作、不自动交付；在途制作也不阻塞保存后继工程（§4.2.1）。
  async publishProject(context: RequestContext, input: ToolPublishProject): Promise<ArtifactRevision> {
    const request = this.requireRunningRequest(context);
    if (request.delivery_closed) throw new AgentToolError("DELIVERY_CLOSED", "本请求已完成正式交付，不能再封存工程。");
    requireWork(this.db, context.actorId, context.conversationId, input.workId);
    if (!this.creative || !this.blobs) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "工程封存通道未装配。");
    const manifest = new Set(input.files);
    if (manifest.size !== input.files.length) throw new AgentToolError("INVALID_INPUT", "工程文件清单里有重复路径。");
    // entrypoint 至少引用一个清单内文件；依赖锁与时间线必须是清单成员。路径边界由 runner 的工程路径校验兜底。
    if (!input.entrypoint.argv.some(token => manifest.has(token))) {
      throw new AgentToolError("INVALID_INPUT", "entrypoint 必须执行清单内的文件。");
    }
    for (const member of [...input.dependencyLocks, ...input.timelineFiles]) {
      if (!manifest.has(member)) throw new AgentToolError("INVALID_INPUT", "依赖锁与时间线文件必须属于工程清单。");
    }
    // Skill 模板/字体/脚本只在编辑会话的只读挂载里，不随冻结工程进入执行环境；
    // 真正用到的资源必须先进工程清单，entrypoint 不能留下 /skills/ 临时路径。
    if (input.entrypoint.argv.some(token => token === "/skills" || token.startsWith("/skills/"))) {
      throw new AgentToolError("INVALID_INPUT", "entrypoint 不能引用 /skills/ 临时资源；请把用到的 Skill 模板/字体/脚本复制进工程清单并以相对路径引用。");
    }

    // 事务外读取工程文件与宿主镜像标识；读取结果进入事务前不再变化（容器内文件由本轮原生工具写定）。
    const runner = this.creative.runner;
    const workspace = this.creative.workspace(context.conversationId, input.workId);
    const runtimeImage = await runner.imageId(workspace);
    const fileBytes = await Promise.all(input.files.map(file => runner.readFile(workspace, file)));
    // input.files 契约至少一项；map 后恢复非空元组类型。
    const files = input.files.map((file, index): ProjectFile => {
      const blob = this.blobs!.persist(context.actorId, context.conversationId, fileBytes[index]!, projectFileMime(file), null);
      return { relativePath: file, blobId: blob.id, digest: blob.digest, purpose: "source" };
    }) as [ProjectFile, ...ProjectFile[]];

    const content: CreativeProjectContent = {
      format: "project", files, entrypoint: input.entrypoint, runtimeImage,
      dependencyLocks: input.dependencyLocks, timelineFiles: input.timelineFiles, sourceRevisions: input.sourceRevisions,
    };
    const write = this.db.transaction((): ArtifactRevision => {
      // 文件读取是网络往返：落库前复核请求仍在运行、交付未关闭。
      const current = this.requireRunningRequest(context);
      if (current.delivery_closed) throw new AgentError("DELIVERY_CLOSED", "本请求已完成正式交付，不能再封存工程。");
      for (const ref of input.sourceRevisions) {
        const hit = this.db.prepare(
          "SELECT r.id FROM artifact_revisions r JOIN artifacts a ON a.id = r.artifact_id WHERE r.artifact_id=? AND r.id=? AND a.conversation_id=? AND a.owner_id=?",
        ).get(ref.artifactId, ref.revisionId, context.conversationId, context.actorId);
        if (!hit) throw new AgentError("INVALID_INPUT", "来源修订不在当前会话，不能封存进工程。");
      }
      const now = this.clock();
      let artifact: ArtifactRow;
      if (input.artifactId !== undefined) {
        const row = getArtifactRow(this.db, context.actorId, input.artifactId);
        if (!row || row.conversation_id !== context.conversationId || row.kind !== "project") {
          throw new AgentError("TARGET_SCOPE_MISMATCH", "要修改的工程不存在或不属于当前会话。");
        }
        // 工程修订只在归属的视频创作内续版（F04）：不能把 A 创作的工程以 baseRevisionId 续到 B 名下；
        // B 需要同源工程时另行封存新工程。
        if (row.work_id !== input.workId) {
          throw new AgentError("TARGET_SCOPE_MISMATCH", "这份工程属于其他视频创作，不能在该创作下续版。");
        }
        if (row.head_revision_id !== input.baseRevisionId) {
          throw new AgentError("STALE_REVISION", "工程已更新，请基于当前最新版本重新封存。", { currentRevisionId: row.head_revision_id });
        }
        artifact = row;
      } else {
        const artifactId = newAgentId("art");
        this.db.prepare(
          `INSERT INTO artifacts(id, conversation_id, owner_id, title, kind, work_id, head_revision_id, head_revision_number, created_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'project', ?, NULL, 0, ?, ?, ?)`,
        ).run(artifactId, context.conversationId, context.actorId, input.title, input.workId,
          nextSeq(this.db, "artifacts", context.conversationId), now, now);
        artifact = getArtifactRow(this.db, context.actorId, artifactId)!;
      }
      const revision = insertRevision(this.db, now, artifact, input.baseRevisionId ?? null,
        { title: input.title, kind: "project", content }, context.requestId);
      return rowToArtifactRevision(revision);
    });
    return write();
  }

  // 本地免费渲染受理（render_project）：核对请求边界后交给 ProductionService 冻结目标并建立 run。
  async renderProject(context: RequestContext, input: ToolRenderProject): Promise<LocalCreationReceipt> {
    const request = this.requireRunningRequest(context);
    if (request.delivery_closed) throw new AgentToolError("DELIVERY_CLOSED", "本请求已完成正式交付，不能再受理本地渲染。");
    if (!this.production) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "免费本地渲染通道未装配。");
    return this.production.admitLocalRender(context.actorId, context.conversationId,
      { requestId: context.requestId, messageId: context.actionSourceMessageId }, input);
  }

  // 免费配音（dub_free）：edge-tts 维护版客户端产 mp3 与词级边界；时长按真实解码结果落库，
  // 边界放在修订内部（RevisionRef 对齐天然成立，read_artifact 读修订即可见）。失败原样透传真实原因，
  // 不暗换付费 speech 型号、不换语音重试。
  async dubFree(context: RequestContext, input: ToolDubFree, signal?: AbortSignal): Promise<DubFreeResult> {
    const request = this.requireRunningRequest(context);
    if (request.delivery_closed) throw new AgentToolError("DELIVERY_CLOSED", "本请求已完成正式交付，不能再生成免费配音。");
    const config = captureEdgeTtsConfig(this.db);
    if (!config) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "免费配音未启用，可在「免费服务 → 配音」中选择语音并打开。");
    if (!this.blobs) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "配音存储通道未装配。");
    const voice = input.voice ?? config.voice;
    const rate = input.rate ?? "+0%";
    let stdout: string;
    try {
      const pending = runDubPython(config.pythonCommand, ["-I", "-c", DUB_DRIVER_PYTHON], {
        timeout: 180_000, maxBuffer: 64 * 1024 * 1024, signal,
      });
      // 异步 execFile 不支持 input 选项（仅同步变体支持），必须经 .child 手动写入并结束 stdin。
      // 解释器启动失败时该流会 EPIPE，真实原因由下方 catch 承载，这里只防未处理的流错误事件。
      pending.child.stdin?.on("error", () => {});
      pending.child.stdin?.end(JSON.stringify({ text: input.text, voice, rate }));
      ({ stdout } = await pending);
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal?.aborted) throw error;
      // 驱动 traceback 的末尾就是真实异常；退出被杀/spawn 失败时 stderr 是空串而非 undefined，需显式回退 message。
      const stderr = ((error as { stderr?: string | Buffer }).stderr ?? "").toString().trim();
      const detail = stderr || (error as Error).message;
      throw new AgentToolError("TEMPORARILY_UNAVAILABLE", `免费配音调用失败：${detail.slice(-400)}`);
    }
    // 外部进程输出只在这里校验一次；之后的 boundaries/audioBytes 是已验证的内部数据。
    const parsed = JSON.parse(stdout) as { audioB64?: unknown; boundaries?: unknown };
    const boundaries = (Array.isArray(parsed.boundaries) ? parsed.boundaries : []).map((item): SpeechBoundary => {
      const boundary = item as { text?: unknown; offsetMs?: unknown; durationMs?: unknown };
      if (typeof boundary.text !== "string" || !boundary.text
        || !Number.isInteger(boundary.offsetMs) || !Number.isInteger(boundary.durationMs)) {
        throw new AgentToolError("TEMPORARILY_UNAVAILABLE", "免费配音返回的边界数据形状不正确。");
      }
      // Number.isInteger 不做类型收窄；形状在此边界校验一次后，内部按 number 使用。
      return { text: boundary.text, offsetMs: boundary.offsetMs as number, durationMs: boundary.durationMs as number };
    });
    const audioBytes = typeof parsed.audioB64 === "string" ? Buffer.from(parsed.audioB64, "base64") : Buffer.alloc(0);
    if (audioBytes.length === 0) throw new AgentToolError("TEMPORARILY_UNAVAILABLE", "免费配音没有返回音频数据。");
    // 时长不信任服务方口径：解码实际文件核实（也是可播放性的真实检查）。
    let durationMs: number;
    const dir = await mkdtemp(join(tmpdir(), "frame-dub-"));
    try {
      const file = join(dir, "dub.mp3");
      await writeFile(file, audioBytes);
      durationMs = (await probeAudioFile(file, signal)).durationMs;
    } catch (error) {
      if ((error as Error).name === "AbortError" || signal?.aborted) throw error;
      if (error instanceof InvalidAudioFile) {
        throw new AgentToolError("TEMPORARILY_UNAVAILABLE", "免费配音返回的音频无法解码为有效的 MP3。");
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // 本次没有返回任何边界事件时如实标 none，不编造词级/句级。
    const granularity: DubbedSpeechMeta["granularity"] = boundaries.length ? "word" : "none";
    const title = input.text.replace(/\s+/g, " ").trim().slice(0, 40) || "免费配音";
    const write = this.db.transaction((): DubFreeResult => {
      // 网络往返与解码之后：落库前复核请求仍在运行、交付未关闭。
      const current = this.requireRunningRequest(context);
      if (current.delivery_closed) throw new AgentError("DELIVERY_CLOSED", "本请求已完成正式交付，不能再生成免费配音。");
      const now = this.clock();
      const blob = this.blobs!.persist(context.actorId, context.conversationId, audioBytes, "audio/mpeg", durationMs);
      const content: MediaContent = {
        format: "media", blobId: blob.id, mimeType: "audio/mpeg", durationMs,
        dub: { text: input.text, voice, rate, granularity, boundaries },
      };
      const artifactId = newAgentId("art");
      this.db.prepare(
        `INSERT INTO artifacts(id, conversation_id, owner_id, title, kind, work_id, head_revision_id, head_revision_number, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'audio', NULL, NULL, 0, ?, ?, ?)`,
      ).run(artifactId, context.conversationId, context.actorId, title,
        nextSeq(this.db, "artifacts", context.conversationId), now, now);
      const artifact = getArtifactRow(this.db, context.actorId, artifactId)!;
      const revision = insertRevision(this.db, now, artifact, null, { title, kind: "audio", content }, context.requestId);
      return { artifactId, revisionId: revision.id, durationMs, granularity, boundaryCount: boundaries.length, voice, rate };
    });
    return write();
  }

  private requireRequest(context: RequestContext): RequestRow {
    const request = getRequestRow(this.db, context.actorId, context.requestId);
    if (!request || request.conversation_id !== context.conversationId) {
      throw new AgentError("REQUEST_NOT_RUNNING", "请求不存在或不属于当前会话。");
    }
    return request;
  }
  private requireRunningRequest(context: RequestContext): RequestRow {
    const request = this.requireRequest(context);
    if (request.state !== "running" || request.execution_epoch !== context.executionEpoch || request.stop_requested) {
      throw new AgentError("REQUEST_NOT_RUNNING", "请求已结束或被停止，本回合的工具调用不再生效。");
    }
    return request;
  }
}

// —— 免费配音驱动 ——
// 不手写服务协议：经同一包（edge-tts 维护版）已验证的 Python API 取音频与词级边界，驱动只做
// stdin JSON → stdout JSON 的薄封装。offset/duration 原始单位 100ns，这里换算为毫秒；
// boundary="WordBoundary" 请求逐词事件；服务一条事件都没给时 boundaries 为空，由调用方如实标 none。
const DUB_DRIVER_PYTHON = `
import asyncio, base64, json, os, sys
from urllib.parse import urlsplit
from urllib.request import proxy_bypass_environment
import edge_tts
from edge_tts.constants import WSS_URL

async def main():
    request = json.loads(sys.stdin.read())
    proxy = next((os.environ[name] for name in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy") if name in os.environ), None)
    no_proxy = os.environ.get("NO_PROXY", os.environ.get("no_proxy", ""))
    if proxy_bypass_environment(urlsplit(WSS_URL).hostname, {"no": no_proxy}):
        proxy = None
    communicate = edge_tts.Communicate(request["text"], request["voice"], rate=request["rate"], boundary="WordBoundary", proxy=proxy or None)
    audio = bytearray()
    boundaries = []
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            audio.extend(chunk["data"])
        elif chunk["type"] == "WordBoundary":
            boundaries.append({
                "text": chunk["text"],
                "offsetMs": round(chunk["offset"] / 1e4),
                "durationMs": round(chunk["duration"] / 1e4),
            })
    sys.stdout.write(json.dumps({"audioB64": base64.b64encode(bytes(audio)).decode(), "boundaries": boundaries}))

asyncio.run(main())
`;

const runDubPython = promisify(execFile);

// 工程文件的描述性类型；执行时按字节写回工作区，不依赖这里的 MIME。
const PROJECT_FILE_MIME: Record<string, string> = {
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
  ".py": "text/x-python", ".sh": "text/x-shellscript",
  // 媒体工程文件按扩展名登记准确 MIME：作品库选材据此区分共享 blob 与文本副本（G4-2）。
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
};
function projectFileMime(file: string): string {
  return PROJECT_FILE_MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream";
}

// Pi 工具输出的内容块：文本或内嵌图像（SDK 层按模型能力决定是否投喂图像）。
type ToolContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// 视频帧带原始画布尺寸：FFmpeg 先限尺寸、SDK 可能再压，任一缩放发生时用一条说明把
// 模型坐标映射回视频原始分辨率；帧未被缩放时不需要说明。
async function resizedImageBlocks(bytes: Buffer, mimeType: string, video?: { width: number; height: number }): Promise<ToolContentBlock[]> {
  const resized = await resizeImage(bytes, mimeType);
  if (!resized) throw new AgentToolError("CAPABILITY_UNAVAILABLE", "图像无法缩放到模型可接受的大小。");
  const note = video && (resized.width < video.width || resized.height < video.height)
    ? `[Image: original ${video.width}x${video.height}, displayed at ${resized.width}x${resized.height}. Multiply coordinates by ${(video.width / resized.width).toFixed(2)} to map to original image.]`
    : formatDimensionNote(resized);
  return [
    ...(note ? [{ type: "text" as const, text: note }] : []),
    { type: "image", data: resized.data, mimeType: resized.mimeType },
  ];
}

// 头/中/尾代表帧时间基于视频轨事实：容器时长可能被更长音轨带偏，固定 0.9×时长也可能
// 落在最后一帧之后（低帧数视频必然如此），那会让整个读取报"没有可抽取的画面"。
// 尾点收到最后一帧，头/中点仍按视频轨时长取比例；读不出帧率时保留 0.9 比例。
function representativeFrameTimes(video: VideoFileFacts): [number, number, number] {
  const intervalMs = video.frameRate ? Math.round(1000 / video.frameRate) : 0;
  const tailMs = intervalMs > 0 && video.videoDurationMs > intervalMs
    ? video.videoDurationMs - intervalMs
    : Math.round(video.videoDurationMs * 0.9);
  return [Math.round(video.videoDurationMs * 0.1), Math.round(video.videoDurationMs * 0.5), tailMs];
}

// read_artifact 的媒体呈现：图片返回真实图像块；视频按 frameTimesMs 抽帧并带时间标注，
// 未给时间点时退回头/中/尾三个代表帧并写明已看范围；音频返回 null 由调用方回退事实文本——
// 没有独立听音能力，不假装听过。
async function presentMedia(
  blobs: import("./production-blobs.js").ProductionBlobs,
  ownerId: string,
  content: MediaContent,
  frameTimesMs: readonly number[] | undefined,
  signal?: AbortSignal,
): Promise<ToolContentBlock[] | null> {
  const file = blobs.filePath(blobs.get(ownerId, content.blobId).digest);
  if (content.mimeType === "image/jpeg" || content.mimeType === "image/png") {
    return resizedImageBlocks(await readFile(file), content.mimeType);
  }
  if (content.mimeType === "video/mp4" || content.mimeType === "video/webm") {
    const explicit = frameTimesMs?.length ? frameTimesMs : undefined;
    const duration = content.durationMs;
    const facts = await probeVideoFile(file, undefined, signal);
    const times = explicit ?? representativeFrameTimes(facts);
    const frames = await extractVideoFrames(file, times, signal);
    const blocks: ToolContentBlock[] = explicit ? [] : [{
      type: "text", text: `已看范围：头/中/尾 3 个代表帧（总时长 ${duration}ms）；要核对具体画面时用 frameTimesMs 指定毫秒时间点。`,
    }];
    for (const [index, frame] of frames.entries()) {
      blocks.push({ type: "text", text: `t=${times[index]}ms${explicit ? "" : "（代表帧）"}` });
      blocks.push(...await resizedImageBlocks(frame, "image/png", facts));
    }
    return blocks;
  }
  return null;
}

// read_artifact 的作品库文件卡呈现（§11.7 来源5/6）：文本类 MIME 读回原文（超长截断并注明）；
// 二进制只给可证实事实，不把读不出的字节冒称已理解，需要内容时由原生工具在输入位置处理。
async function presentFile(
  blobs: import("./production-blobs.js").ProductionBlobs,
  ownerId: string,
  content: FileContent,
): Promise<ToolContentBlock[]> {
  const blob = blobs.get(ownerId, content.blobId);
  if (content.mimeType.startsWith("text/") || content.mimeType === "application/json") {
    const bytes = await readFile(blobs.filePath(blob.digest));
    const truncated = bytes.length > 262_144;
    const text = (truncated ? bytes.subarray(0, 262_144) : bytes).toString("utf8");
    return [{ type: "text", text: `${content.path}（${content.mimeType}${truncated ? `，已截断前 256 KiB／共 ${blob.size_bytes} 字节` : ""}）：\n${text}` }];
  }
  return [{ type: "text", text: `二进制文件 ${content.path}（${content.mimeType}，${blob.size_bytes} 字节）：字节不能当作文本读取；已准备到作品输入位置的文件见上下文 libraryInputs（inputs/library/ 下，用原生工具处理），未准备时先明确目标作品（read_work activate 或 start_work）。` }];
}

// —— 模型侧工具声明 ——

export interface ActiveRequestContext {
  actorId: string;
  conversationId: string;
  requestId: string;
  executionEpoch: number;
  target: Target | null;
  /** 宿主注入的当前真实用户消息；steering 只在 Pi 原生接收后更新。 */
  actionSourceMessageId: string;
  /** 本回合明确激活的创作（start_work 成功或 read_work activate）；新请求自动清空。 */
  activatedWorkId?: string;
  nativeRecovery?: boolean;
}

export function buildAgentTools(
  holder: { current: ActiveRequestContext | null },
  tools: PiBusinessTools,
  /** 媒体呈现：读取 blob 字节与视频抽帧；缺省时图像/视频只返回事实文本。 */
  media?: { blobs: import("./production-blobs.js").ProductionBlobs },
  /** 间接读取 Skill 参考文件（离线装配）；隔离创作环境用原生 read，不传本参数。 */
  skills?: { root: string; directories?: () => string[] },
  /** 作品库选材输入准备（§11.7 来源6/7）：作品明确（start_work / read_work activate）后触发。 */
  libraryInputs?: { ensure: (actorId: string, conversationId: string, workId: string) => Promise<void> },
): ToolDefinition[] {
  // 旧装配的间接读取：Skill 目录内只读，路径解析不能越出已发现的技能目录。
  const readSkillFile: ToolDefinition | null = skills
    ? (() => {
      const skillRootReal = realpathSync(skills.root);
      const tool: ToolDefinition = {
        name: "read_skill_file",
        label: "读取技能参考文件",
        description: "读取已安装技能目录内的说明或参考文件。可使用技能相对路径或 SDK 给出的已安装技能绝对路径，不能越出技能目录。",
        parameters: Type.Object({
          path: Type.String({ minLength: 1, maxLength: 512, description: "技能目录内的相对路径，例如 video-script/SKILL.md" }),
        }),
        async execute(_toolCallId, args) {
          const relativePath = String((args as { path?: unknown }).path ?? "");
          let resolved: string;
          try { resolved = realpathSync(isAbsolute(relativePath) ? relativePath : join(skillRootReal, relativePath)); }
          catch { throw new AgentToolError("NOT_FOUND", "技能文件不存在，请使用已安装技能目录中提供的路径。"); }
          const allowed = (skills.directories?.() ?? [skillRootReal]).map(root => realpathSync(root));
          const root = allowed.find(directory => resolved === directory || resolved.startsWith(directory + sep));
          if (!root) throw new AgentToolError("FORBIDDEN", "路径超出已发现的技能目录。");
          const rel = relative(root, resolved);
          const stat = statSync(resolved);
          if (!stat.isFile() || stat.size > 262_144) throw new AgentToolError("INVALID_INPUT", "技能参考文件必须是小于 256 KiB 的文件。");
          const text = readFileSync(resolved, "utf8");
          return { content: [{ type: "text" as const, text }], details: { path: rel } };
        },
      };
      return tool;
    })()
    : null;

  const readArtifact: ToolDefinition = {
    name: "read_artifact",
    label: "读取产物修订",
    description: "读取当前会话某个产物指定修订的完整内容。文本与工程清单直接读回；图片返回真实图像；视频按 frameTimesMs（毫秒，最多 8 个时间点）抽取带时间标注的画面，改镜头前先用它核对实际画面；未给时间点时返回头/中/尾三个代表帧并写明已看范围。音频只返回可证实的事实（时长/采样率），没有独立听过音频的能力时不声称听过。作品库文件卡（format=file）文本类读回原文、二进制只给事实清单，不把字节冒称文本。修改前必须先读过用户绑定的基准修订。",
    parameters: inlineSchema("ToolReadArtifact"),
    async execute(toolCallId, args, signal) {
      const context = requireContext(holder, toolCallId);
      const input = args as ToolReadArtifact;
      const revision = await tools.readArtifact(context, input);
      const content = revision.content;
      const mediaPresentation = media && content.format === "media" ? await presentMedia(media.blobs, context.actorId, content, input.frameTimesMs, signal) : null;
      if (mediaPresentation) return { content: mediaPresentation, details: { artifactId: revision.artifactId, revisionId: revision.revisionId } };
      const filePresentation = media && content.format === "file" ? await presentFile(media.blobs, context.actorId, content) : null;
      if (filePresentation) return { content: filePresentation, details: { artifactId: revision.artifactId, revisionId: revision.revisionId } };
      const note = content.format === "media" && (content.mimeType === "video/mp4" || content.mimeType === "video/webm") && !input.frameTimesMs
        ? "（视频修订：给出 frameTimesMs 时间点后可抽取对应画面）" : "";
      return {
        content: [{ type: "text" as const, text: JSON.stringify(revision) + note }],
        details: { artifactId: revision.artifactId, revisionId: revision.revisionId },
      };
    },
  };

  const deliverArtifacts: ToolDefinition = {
    name: "deliver_artifacts",
    label: "交付本轮草稿",
    description: "将本轮需要用户审阅的草稿或修订放到工作台（items 为 1-8 项，可包含不同主题与类型）。这是交草稿，不是定稿或确认；视频创作中的内容草稿也必须用本工具交付，不能仅在聊天中输出。Prompt 和普通讨论仍直接在聊天中回复。准备齐本轮草稿后一次提交；成功后暂停等用户。修改项必须精确匹配 artifactId 与当前 baseRevisionId。修改前必须先 read_artifact 读过用户绑定的基准修订；没有预绑定也要按用户文字指名与 read_artifact 解析真实对象，不确定时只问一次。"
      + "正式视频事项的草稿用 reviewGroups 说明归属：已有组/项传准确 groupId/itemId（以 start_work、read_work 或此前交付回执返回的为准，不要编造）；新组/项用 create 并自带 key（仅本次调用内去重）、title、label、role、required，服务端一次分配身份并在回执 reviewTargets 里返回稳定 id。新项可以先无主稿，交付后按制作进度补；不要为取得 id 先交占位媒体。"
      + "每个交付项按需要附 inputSources（实际采用的内容来源，真实修订或逐字消息原文）与 reviewInputs（本次制作必需的认可依据，引用 read_work 返回的准确 confirmationId）；代码生成的媒体必须先 publish_project，再以对应 project 修订参与交付。"
      + "本地产出用 content 的 local_output 分支引用已登记的 run/operation 输出或产物修订；不要引用 bash 临时文件或裸工作区路径。"
      + "多段落文稿用 MarkdownContent.sections 分段：每段带稳定 id、title 与完整可独立阅读的 text，按阅读/播放顺序排列。用户要采用聊天原文或已有修订作内容时不要交付副本，改用 confirm_review 在认可动作里直接引用原文或修订。"
      + "同一次交付原子完成并关闭本回合变更边界；成功后只做说明，等用户下一步。",
    parameters: inlineSchema("ToolDelivery"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const receipt = await tools.deliverArtifacts(context, args as ToolDelivery);
      return {
        content: [{ type: "text" as const, text: `交付完成：${JSON.stringify(receipt)}` }],
        details: receipt,
      };
    },
  };

  const prepareProduction: ToolDefinition = {
    name: "prepare_production",
    label: "准备制作提案",
    description: "用户明确委托准备付费制作后，创建待确认的提案（含服务端报价与有效期）；本工具不能批准执行。"
      + "对话文字可直接用 spec.inputSources 的 message_text 分支（真实 messageId 加逐字原文），没有作品引用时 inputSources 留空，不要为此先创建 Prompt 作品。"
      + "模型与启用参数取自 frame-current-state.mediaModels；render 为本地合成，model:null。按本次需要安排操作，不额外增加步骤；创建次数由通道固定，不要自行加重试。"
      + "正式整片（purpose=production）的成片必须带 workId，且方案等必要依据已通过 confirm_review 认可；受理依据放 reviewInputs（引用 read_work 返回的准确 confirmationId 与事项），实际生成输入放 inputSources，两者不要混同。已认可的方案修订直接作为 inputSources 引用，不复制、不追加报价到正文、不让用户重新认可同一稿。"
      + "spec.outputTarget 声明成片交付到哪个审阅组/事项：已有组/项传 read_work 或交付回执里的准确 groupId/itemId，或用 create 声明新组/新项（角色须接收视频，如 video/clip）。最终视频提案缺少 outputTarget 会被拒绝，服务端不会替用户猜位置；需要核对当前组结构就先 read_work。"
      + "带独立逐字配音的方案必须在 MarkdownContent.narrationText 保存整条旁白原文，speech 的实际输入逐字一致。同稿同句重报直接引用同一方案修订；换台词先交新方案。不得用旧方案引用配新台词。"
      + "用户明确说替换某张报价（例如降低并替换原额度）时，replacesProposal 传 read_proposal 读到的准确 proposalId/digest；只撤同事项同方案同范围的指定旧单。普通备选不填。替换额度不足返回 stale 并明确旧报价已撤、本次未就绪，不让用户回用旧高额度。"
      + "为已有视频准备新版本时，先用 read_run / read_proposal 核对上一版实际使用的输入与产出：未受影响的段落直接引用原有 blob 或产物修订作为 render 输入，只为受影响的段落新增生成操作；本会话已采用的素材同样优先复用。不为省事把所有片段重新生成，也不为复用重复安排付费操作。"
      + "需要指定片段区间/图片停留时用 timed_narrated_concat：segments 按成片顺序给出视频 inputSlot/startMs/durationMs 或图片 inputSlot/durationMs，narrationInputSlot 指定旁白；成片时长取片段之和，旁白替换原声、不足补静音、超过画面总长会如实失败。"
      + "三路声音用mixed_concat：segments与必需segmentIds逐段对应方案，video逐段originalGain（省略1）；可加一路已采用music（candidateId绑定该音频槽，明确选区/位置/播放长/repeat/gain/fades/duckUnderNarration）和完整narration（槽/位置/gain）。gain0–1，画面总长≤120s，全部输入合计≤24。音乐不足不暗循环；独立配音不裁词、不变速、不延长画面；未知原声不能假装分离人声和背景乐。"
      + "换音乐或音量只安排本地render，read_run取得proposalId再read_proposal恢复原始视觉段、原声设置和既有配音；不能用已经混旧曲的整片再叠新曲，也不重生相同画面/旁白。只换型号/音色/台词才有新speech。明确本次MiniMax时用frame-current-state.mediaModels中的准确binding和voice，不改全局默认或失败偷换OpenAI。新混音仍交视频草稿，等待用户认可。"
      + "ordered_concat/narrated_concat 保持完整保留素材与旁白的原语义，不裁剪；无法满足时长差距时如实说明，不得声称可达成长度。",
    parameters: inlineSchema("ToolPrepareProposal"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const proposal = await tools.prepareProduction(context, args as ToolPrepareProposal);
      return {
        content: [{ type: "text" as const, text: `提案已准备：${JSON.stringify({ proposalId: proposal.id, digest: proposal.digest, state: proposal.state, expiresAt: proposal.expiresAt })}` }],
        details: { proposalId: proposal.id },
      };
    },
  };

  const publishProject: ToolDefinition = {
    name: "publish_project",
    label: "封存代码工程",
    description: "把当前工程要留存的源码、模板、字体与时间线连同运行入口冻结为一份 project 修订（files 为 1-512 个工作区相对路径；entrypoint 执行清单内文件；dependencyLocks/timelineFiles 必须是清单成员）。只封存：不认可、不受理制作、不把文件自动当成交付卡；之后用 render_project 执行或以 local_output/artifact_revision 引用这份修订。sourceRevisions 记录本次实际采用的会话内修订，逐字素材引用真实修订，不复制内容。改工程时传 artifactId 与准确 baseRevisionId，按清单整体替换。运行前收集，不定稿时补采当前目录。"
      + "工程真正用到的 Skill 模板/字体/脚本先复制进工作区并列入 files，entrypoint 不引用 /skills/ 只读路径（执行环境不挂载它）。"
      + "在途制作不阻塞保存后继工程；同一工程的后续版本先改工作区文件再重新封存。",
    parameters: inlineSchema("ToolPublishProject"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const revision = await tools.publishProject(context, args as ToolPublishProject);
      return {
        content: [{ type: "text" as const, text: `工程已封存：${JSON.stringify({ artifactId: revision.artifactId, revisionId: revision.revisionId, digest: revision.digest })}` }],
        details: { artifactId: revision.artifactId, revisionId: revision.revisionId },
      };
    },
  };

  const renderProject: ToolDefinition = {
    name: "render_project",
    label: "受理本地渲染",
    description: "把冻结的 project 修订与声明输出交给现有本地 worker 免费执行，立即返回 run（后台完成，不等待结果、完成后不自动点评）。每个操作声明 operationId/outputSlot、inputs（blob/媒体修订作为数据输入，按数组下标物化为 inputs/<slot>.<扩展名>；operation_output 串接前序产物；文本与工程引用不落文件）、code_project 参数（projectRevision 指向 publish_project 返回的准确工程修订、entrypoint 与该修订冻结的入口完全一致、outputPath 是本次执行将产生的工作区相对文件——不必预先存在，也不能与封存文件或 inputs/<slot>.* 落位同名、expectedMediaKind 与该媒体实际需要的字段：图片给尺寸与 png/jpeg，音频给采样率/声道与 wav/mp3，视频才给 fps）与 target（已有组/项传准确 id，新组/项用 create 声明，服务端一次分配身份）。执行按工程冻结的 argv 逐项直传进程，入口正常结束但没生成声明输出即失败，不会交付旧文件。"
      + "正式整片（purpose=production 的视频输出）必须先有组审阅认可，reviewInputs 引用 read_work 返回的准确 confirmationId；初始样张按 scope 判断可空。受理后该作品在途期间不再受理新制作，但保存后继工程与独立认可不受影响。产物是否交付另行用 deliver_artifacts 引用运行输出。",
    parameters: inlineSchema("ToolRenderProject"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const receipt = await tools.renderProject(context, args as ToolRenderProject);
      return {
        content: [{ type: "text" as const, text: `本地渲染已受理：${JSON.stringify({ runId: receipt.run.id, state: receipt.run.state, reviewTargets: receipt.reviewTargets })}` }],
        details: { runId: receipt.run.id },
      };
    },
  };

  const readProposal: ToolDefinition = {
    name: "read_proposal",
    label: "读取制作提案",
    description: "读取当前会话指定提案的完整范围（操作、输入修订绑定、顺序、报价与有效期）。回答制作状态或费用前先用它核对事实。",
    parameters: inlineSchema("ToolReadProposal"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const proposal = await tools.readProposal(context, args as ToolReadProposal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(proposal) }],
        details: { proposalId: proposal.id },
      };
    },
  };

  const readRun: ToolDefinition = {
    name: "read_run",
    label: "读取制作运行",
    description: "读取当前会话指定制作运行的完整事实：状态、失败原因（issue）、输入/输出修订、按播放顺序的片段（segments：每段对应方案/内容段落、媒体与执行状态）与费用口径（finance）。不要猜测失败、费用或片段事实，先读它。",
    parameters: inlineSchema("ToolReadRun"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const run = await tools.readRun(context, args as ToolReadRun);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(run) }],
        details: { runId: run.id },
      };
    },
  };

  const listProduction: ToolDefinition = {
    name: "list_production",
    label: "列出制作索引",
    description: "分页列出当前会话的制作对象（kind=proposals 或 runs，默认每页 10 条）。用 nextCursor 翻页发现更早对象，再用 read_proposal / read_run 读取详情。",
    parameters: inlineSchema("ToolListProduction"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const page = await tools.listProduction(context, args as ToolListProduction);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(page) }],
        details: { kind: page.kind, count: page.items.length, nextCursor: page.nextCursor },
      };
    },
  };

  const searchMaterials: ToolDefinition = {
    name: "search_materials",
    label: "搜索免费素材",
    description: "搜索已启用来源的图片、视频或音乐（kind=image|video|audio，limit 1-10）。provider省略时图片/视频沿Pexels，音乐默认首个已启用曲源，也可按需求指定。Incompetech适合按英文情绪、乐器或曲名找配乐，Wikimedia适合乐曲与演唱录音；需要比较来源可分别搜索。指定来源不暗换。普通找音乐不start_work。候选按批次保存；跨轮先read_material_batch读取原批次与序号，不能取最新批次替代。采用后才可deliver_artifacts交音频草稿。声乐与语言只按来源标注，未知不猜，不能说已经听过；无previewUrl时采用后本地试听。为正式视频找素材须带workId并遵守暂停。视觉dimensionsKind=source仅指原作，download才是可采用变体，实际像素看采用结果。",
    parameters: inlineSchema("ToolSearchMaterials"),
    async execute(toolCallId, args, signal) {
      const context = requireContext(holder, toolCallId);
      const input = args as ToolSearchMaterials;
      const result = await tools.searchMaterials(context, input, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { kind: input.kind, count: result.results.length, batchId: result.batchId },
      };
    },
  };

  const readMaterialBatch: ToolDefinition = {
    name: "read_material_batch",
    label: "读取素材批次",
    description: "按 batchId 读回当前会话某次搜索的完整候选（原查询、时间与原始顺序，空结果也可读）。用户说“第二个”时要先读原批次再选，不要取最近一次搜索的第二个。",
    parameters: inlineSchema("ToolReadMaterialBatch"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const batch = await tools.readMaterialBatch(context, args as ToolReadMaterialBatch);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(batch) }],
        details: { batchId: batch.batchId, count: batch.results.length },
      };
    },
  };

  const startWork: ToolDefinition = {
    name: "start_work",
    label: "开始视频创作",
    description: "用户明确要正式做一条视频后，为这条视频建立创作事项（标题由用户内容概括）并作为本回合的创作工作区，之后的原生工具直接服务它。普通 Prompt、热点讨论、单独写脚本不要调用。推进节奏按用户需要建审阅组（内容、画面声音方案、成片等），必选依据经用户认可后才能用于正式制作；用户明确要先看局部预览时可以直接做预览，不强迫先补内容稿。",
    parameters: inlineSchema("ToolStartWork"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const work = await tools.startWork(context, args as ToolStartWork);
      if (holder.current) holder.current.activatedWorkId = work.id;
      // §11.7 来源6/7：作品明确后立即把已发送选材原字节准备到其输入位置（含“先发送选材、本消息才 start_work”）。
      if (libraryInputs) await libraryInputs.ensure(context.actorId, context.conversationId, work.id);
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id } };
    },
  };

  const readWork: ToolDefinition = {
    name: "read_work",
    label: "读取视频创作状态",
    description: "读取一条视频创作的审阅组与各项当前稿/已认可对象（confirmationId 与 action）、组版本与关联运行，并附带该视频的相关意见。回答“现在到哪一步/认可的是哪版/有哪些意见”前先用它核对事实。默认只读，不改写入目标；要切换本回合后续原生工具服务的创作时传 activate: true（例如同时有多条创作、用户要继续另一条），它只确定工具归属，不认可、不创建制作。",
    parameters: inlineSchema("ToolReadWork"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const input = args as ToolReadWork;
      const work = await tools.readWork(context, input);
      if (input.activate && holder.current) {
        holder.current.activatedWorkId = work.id;
        // §11.7 来源7：显式切换作品后按新目标准备输入；默认只读 read_work 不写入。
        if (libraryInputs) await libraryInputs.ensure(context.actorId, context.conversationId, work.id);
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id, groups: work.reviewGroups.length, feedback: work.relatedFeedback.length } };
    },
  };

  const confirmReview: ToolDefinition = {
    name: "confirm_review",
    label: "记录审阅认可",
    description: "只记录用户本轮明确表达的认可：approve（认可指定项当前稿，暂停）、approve_and_continue（认可并继续下一组所需工作）、finalize_video（认可已存在的成片修订并定稿）。items 逐项给出准确 itemId 与所认可的来源（真实修订或本次消息原文消息）；不要因为语气接近、假设或引用别人就记录。镜头修改不包含继续认可，不能用本工具绕过改稿失败。本工具不能开始制作。",
    parameters: inlineSchema("ToolConfirmReview"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const work = await tools.confirmReview(context, args as ToolConfirmReview);
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id } };
    },
  };

  const recordWorkFeedback: ToolDefinition = {
    name: "record_work_feedback",
    label: "记录稿件意见",
    description: "把用户本轮消息里对某稿件/成片的具体意见关联到该修订（记入原消息的 target/references/feedback，原文不变）。给出 artifactId+baseRevisionId 时针对那份修订；用户意见针对某视频本身而其内容主稿是聊天原文时，给出 workId，artifactId 与 baseRevisionId 均传 null，意见按该视频与所采用原文关联，不复制稿件。意见只作为下一版依据，不改变正在制作或已开始的版本。用户意见明确针对成片某一片段时，从 read_run 的 run.segments 取 runId 与 segmentId 传入 segment（片段意见需落在具体主稿上）；不要指向不存在的片段，也不要把整片意见写成片段意见。",
    parameters: inlineSchema("ToolRecordWorkFeedback"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const receipt = await tools.recordWorkFeedback(context, args as ToolRecordWorkFeedback);
      return { content: [{ type: "text" as const, text: JSON.stringify(receipt) }], details: { messageId: receipt.messageId } };
    },
  };

  const readTrends: ToolDefinition = {
    name: "read_trends",
    label: "查看平台榜单",
    description: `找短视频选题时读已配置的 NewsNow 榜单：${Object.entries(VIDEO_TOPIC_CHARTS).map(([id, label]) => label + "=" + id).join("、")}。用户指定平台时传相应 sourceIds；省略时读全部已配置来源。保留榜单时间、标题与原链接。找热门配乐才用 musicChart：douyin-music 给曲名搜索页，tiktok-sounds 给 Kabo 公开前五与原声页；两榜分别读取，均不授予音频使用许可。limit 1–20。`,
    parameters: inlineSchema("ToolReadTrends"),
    async execute(toolCallId, args, signal) {
      const context = requireContext(holder, toolCallId);
      const result = await tools.readTrends(context, args as ToolReadTrends, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { sources: result.sources.length, topics: result.topics.length },
      };
    },
  };

  const importMaterial: ToolDefinition = {
    name: "import_material",
    label: "采用候选素材",
    description: "采用本会话原批次的准确candidateId并登记真实来源；重复采用复用原文件与首次许可。只是内容准备，不认可方案、不授权制作、不定稿；正在为视频采用须带workId。FreeToUse免费音乐只适用个人社交平台UGC且署名，须从用户明确用途填写usage:personal_social_ugc；商业/品牌/赞助等other不适用，用途不明只问这一点，不自动买许可。下载失败如实报告，不以目录成功称已可用。视觉实际像素看返回dimensions，音频返回实际时长与可播放blob。",
    parameters: inlineSchema("ToolImportMaterial"),
    async execute(toolCallId, args, signal) {
      const context = requireContext(holder, toolCallId);
      const result = await tools.importMaterial(context, args as ToolImportMaterial, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { blobId: result.blobId, provenance: result.provenance },
      };
    },
  };

  const dubFree: ToolDefinition = {
    name: "dub_free",
    label: "免费配音",
    description: "把一段文字合成为免费配音的音频修订（Edge 免费语音；优先用它，不占用付费 speech 型号）。voice 省略时用免费服务设置中的当前语音，rate 如 +10% 或 -5%。返回真实解码时长 durationMs 与词级边界（毫秒，相对该音频修订起点；granularity=none 表示本次没有边界事件，不要编造）。放进时间线前按片段的 offset、trim 与 speed 换算边界时间，并按 durationMs 实际时长安排片段，避免截尾。失败返回真实原因；不会自动改用付费配音或换语音重试。",
    parameters: inlineSchema("ToolDubFree"),
    async execute(toolCallId, args, signal) {
      const context = requireContext(holder, toolCallId);
      const result = await tools.dubFree(context, args as ToolDubFree, signal);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        details: { artifactId: result.artifactId, revisionId: result.revisionId },
      };
    },
  };

  return [readArtifact, deliverArtifacts, prepareProduction, publishProject, renderProject, readProposal, readRun, listProduction,
    searchMaterials, readMaterialBatch, readTrends, importMaterial, dubFree, startWork, readWork, confirmReview, recordWorkFeedback,
    ...(readSkillFile ? [readSkillFile] : [])];
}

function requireContext(holder: { current: ActiveRequestContext | null }, toolCallId: string): RequestContext {
  const active = holder.current;
  if (!active) throw new AgentToolError("REQUEST_NOT_RUNNING", "没有正在执行的请求。");
  return requestContext({ ...active, toolCallId });
}

// 把契约 $defs 内联为独立 JSON Schema（供 TypeBox 参数声明），避免第二份 DTO。
// 只解析契约内部的 #/$defs/... 引用；出现外部引用或循环直接报错。
export function inlineSchema(defName: string): TSchema {
  const defs = (contractsSchema as { $defs: Record<string, unknown> }).$defs;
  if (!defs[defName]) throw new Error(`契约中没有 ${defName}`);
  const resolve = (node: unknown, stack: readonly string[]): unknown => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(item => resolve(item, stack));
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === "string") {
      const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
      if (!match) throw new Error(`契约中出现不支持的引用：${ref}`);
      const name = match[1];
      if (!name || stack.includes(name)) throw new Error(`契约定义循环引用：${name}`);
      const target = defs[name] as Record<string, unknown> | undefined;
      if (!target) throw new Error(`契约缺少定义：${name}`);
      return resolve(target, [...stack, name]);
    }
    return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, resolve(value, stack)]));
  };
  return resolve(defs[defName], [defName]) as TSchema;
}
