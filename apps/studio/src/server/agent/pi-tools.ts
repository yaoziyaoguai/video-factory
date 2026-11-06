import { readFileSync, realpathSync, statSync } from "node:fs";
import { VIDEO_TOPIC_CHARTS } from "../../shared/agent/video-topics.js";
import { isAbsolute, join, relative, sep } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { contractsSchema } from "../../shared/agent/generated/contracts-schema.js";
import type {
  ArtifactRevision, ContentSource, DeliveryReceipt, MaterialBatch, MaterialImportResult, MaterialSearchResult, OperationRequest,
  ProductionIntent, Proposal, RevisionRef, Target, ToolConfirmStage, ToolDelivery, ToolImportMaterial, ToolPrepareProposal,
  ToolReadMaterialBatch, ToolReadProposal, ToolReadRun, ToolReadWork, ToolRecordWorkFeedback,
  ToolReadTrends, ToolSearchMaterials, ToolStartWork, ToolListProduction, ProductionIndexPage, Run, TrendReadResult,
  TrendSnapshot, FeedbackReceipt, Work,
} from "../../shared/agent/generated/contracts.js";
import type { PiBusinessTools, RequestContext, WorkFeedbackView, WorkWithFeedback } from "../../shared/agent/ports.js";
import type { AgentDatabase } from "./db.js";
import { AgentError, AgentToolError } from "./errors.js";
import {
  applyDelivery, applyPrepareProposal, commitInvocationResult, deliveryDigest, getInvocation, getRevisionRow,
  registerInvocation, rowToArtifactRevision, rowToProposal, hasProductionLock,
  NARRATED_CATALOG_KEY, RENDER_CATALOG_KEY, TIMED_NARRATED_CATALOG_KEY,
  type ProposalRow, type QuoteCatalog, type RenderFileProbe,
} from "./artifact-store.js";
import { probeRenderInputs } from "./media-probe.js";
import { captureNewsNowConfig, captureStockConfigs, FREE_SERVICE_LABELS, readFreeServiceSettings } from "./free-service-settings.js";
import { insertEvent } from "./event-log.js";
import { importMaterial, persistSearchBatch, readMaterialBatch } from "./material-store.js";
import {
  createWork, parseCreationState, recordStageConfirmation, relatedWorkFeedback,
  requireContentContinued, requireWork, workInFlight, workProjection,
} from "./creative-work.js";
import { readMusicChart } from "./music-charts.js";
import { NewsNowClient } from "./newsnow-client.js";
import { StockClient, type StockCandidateInput } from "./stock-providers.js";
import { StockKindUnsupportedError, StockUnavailableError } from "./stock-http.js";
import { getScopedProposal, getScopedRunRow, listProductionIndex } from "./production-index.js";
import { toRun, runSegments } from "./production-store.js";
import { getMessageRow, getRequestRow, saveAssistantMessage, type RequestRow } from "./conversation-store.js";
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
  ) {}

  async readArtifact(context: RequestContext, input: RevisionRef): Promise<ArtifactRevision> {
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
    const proposal = getScopedProposal(this.db, context.actorId, context.conversationId, input.proposalId);
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
    // 关联正式事项时先核对阶段许可：内容未认可并明确继续前，不能先给这条视频找素材。
    const workId = input.workId ?? null;
    if (workId) requireContentContinued(this.db, requireWork(this.db, context.actorId, context.conversationId, workId));
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
      if (workId) requireContentContinued(this.db, requireWork(this.db, context.actorId, context.conversationId, workId));
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
    const artifactIds = Object.values(projection.stages)
      .flatMap(stage => stage.draft?.kind === "artifact_revision" ? [stage.draft.artifactId] : []);
    return { ...projection, relatedFeedback: relatedWorkFeedback(this.db, context.conversationId, { workIds: [work.id], artifactIds }) };
  }

  // 普通认可只记录用户已经表达的事实；不推进未要求的下一阶段工作，也不能在这里受理制作。
  async confirmStage(context: RequestContext, input: ToolConfirmStage): Promise<Work> {
    const write = this.db.transaction(() => {
      this.requireRunningRequest(context);
      const result = recordStageConfirmation(this.db, this.clock(), {
        ownerId: context.actorId, conversationId: context.conversationId,
      }, {
        workId: input.workId, action: input.action, subject: input.subject,
        sourceKind: "user_message", sourceId: context.actionSourceMessageId,
      });
      return workProjection(this.db, result.work);
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
      const contentDraft = state.content.draft;
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
        if (!binding && ![state.content, state.plan, state.video].some(stage =>
          [stage.draft, stage.approved].some(source => source?.kind === "artifact_revision" && source.artifactId === input.artifactId))) {
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
    if (input.workId) requireContentContinued(this.db, requireWork(this.db, context.actorId, context.conversationId, input.workId));
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
        // 完整参数摘要（含 stageDrafts）由交付事务与这里共用；仅改关联也必须拒绝。
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
      if (row) return rowToProposal(row, this.db);
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
        return rowToProposal(row, this.db);
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
      }, intent, catalog, probes, input.planSource, input.replacesProposal);
      const result = { proposalId: proposal.id, digest: proposal.digest, state: proposal.state, expiresAt: proposal.expires_at };
      commitInvocationResult(this.db, this.clock(), {
        ownerId: context.actorId, requestId: context.requestId, toolCallId: context.toolCallId,
      }, result, proposal.id);
      saveAssistantMessage(this.db, this.clock(), request, "", "running");
      return rowToProposal(proposal, this.db);
    });
    const proposal = apply();
    this.crashPoint("after-prepare-commit");
    return proposal;
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

// —— 模型侧工具声明 ——

export interface ActiveRequestContext {
  actorId: string;
  conversationId: string;
  requestId: string;
  executionEpoch: number;
  target: Target | null;
  /** 宿主注入的当前真实用户消息；steering 只在 Pi 原生接收后更新。 */
  actionSourceMessageId: string;
  nativeRecovery?: boolean;
}

export function buildAgentTools(
  holder: { current: ActiveRequestContext | null },
  tools: PiBusinessTools,
  skillsRoot: string,
  skillDirectories?: () => string[],
): ToolDefinition[] {
  const skillRootReal = realpathSync(skillsRoot);

  const readSkillFile: ToolDefinition = {
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
      const allowed = (skillDirectories?.() ?? [skillRootReal]).map(root => realpathSync(root));
      const root = allowed.find(directory => resolved === directory || resolved.startsWith(directory + sep));
      if (!root) throw new AgentToolError("FORBIDDEN", "路径超出已发现的技能目录。");
      const rel = relative(root, resolved);
      const stat = statSync(resolved);
      if (!stat.isFile() || stat.size > 262_144) throw new AgentToolError("INVALID_INPUT", "技能参考文件必须是小于 256 KiB 的文件。");
      const text = readFileSync(resolved, "utf8");
      return { content: [{ type: "text" as const, text }], details: { path: rel } };
    },
  };

  const readArtifact: ToolDefinition = {
    name: "read_artifact",
    label: "读取产物修订",
    description: "读取当前会话某个产物指定修订的完整内容。修改前必须先读过用户绑定的基准修订。",
    parameters: inlineSchema("ToolReadArtifact"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const revision = await tools.readArtifact(context, args as RevisionRef);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(revision) }],
        details: { artifactId: revision.artifactId, revisionId: revision.revisionId },
      };
    },
  };

  const deliverArtifacts: ToolDefinition = {
    name: "deliver_artifacts",
    label: "交付本轮草稿",
    description: "将本轮需要用户审阅的草稿或修订放到工作台（items 为 1-8 项，可包含不同主题与类型）。这是交草稿，不是定稿或确认；视频创作中的内容草稿也必须用本工具交付，不能仅在聊天中输出。Prompt 和普通讨论仍直接在聊天中回复。准备齐本轮草稿后一次提交；成功后暂停等用户。修改项必须精确匹配用户绑定的 artifactId 与 baseRevisionId；没有预绑定也要按用户文字指名与 read_artifact 解析真实对象，不确定时只问一次。正式视频的内容/方案主稿用 stageDrafts 指明 workId（以 start_work 返回或 read_work 读到的为准，不要编造）、stage、itemIndex（同批可给 A/B 各自主稿）。stage=content 无论新写还是修改，source 与 proposalRef 都传 null；修改基准只放在 item.baseRevisionId，不放进 source。用户要采用聊天原文或已有修订作内容时不要交付副本，改用 confirm_stage 在认可动作里直接引用原文或修订。stage=plan 的主稿必须给 source，准确指向该视频当前内容主稿：artifact_revision 指该修订，或内容所采用消息的原文 message_text（逐字引用，服务端逐字核对）。方案主稿可带本轮已准备的有效 proposalRef，也可先不带提案。用户之后要求制作时，prepare_production 用 planSource 直接引用已有方案，不为绑定提案再次交付相同内容。"
      + "多片段视频的内容/方案主稿用 MarkdownContent.sections 分段：每段带稳定 id、title 与完整可独立阅读的 text，按播放顺序排列；方案段落可用 sourceSectionIds 指向内容段落 id 建立逐段对应（仅方案段允许）。本轮同时修订内容与对应方案时成对交付：方案项 source 传 {kind:'delivery_item', itemIndex: 指向本批内容项} 且 proposalRef 必须为 null（讨论稿）；成对交付只用于已有认可内容与方案之后的改稿轮，首轮仍先交付内容、等用户认可并明确继续。暂停时可修改当前既有方案：基于其当前 baseRevisionId、同一准确内容来源交付 revise 且 proposalRef:null，保持内容稿与暂停认可原样；不要为改镜头补写继续认可。",
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
    description: "用户明确委托准备制作后，创建待确认的提案（含服务端报价与有效期）；本工具不能批准执行。"
      + "对话文字可直接用 inputs:[{kind:'text',text:'完整原文'}]，没有作品引用时 inputRevisions:[]，不要为此先创建 Prompt 作品。"
      + "模型与启用参数取自 frame-current-state.mediaModels；render 为本地合成，model:null。按本次需要安排操作，不额外增加步骤；创建次数由通道固定，不要自行加重试。"
      + "视频成片必须带 workId，且该视频已认可内容进入方案阶段。已有方案时，在 planSource 引用 read_work 返回的当前方案 artifactId/revisionId，直接准备其制作；不要复制方案、追加报价到方案正文或让用户重新认可同一稿。planSource 是方案关联，不要为此塞入没有用于生成的 inputRevisions。"
      + "带独立逐字配音的方案必须在 MarkdownContent.narrationText 保存整条旁白原文，speech 的实际输入逐字一致。正文/镜头段只写声音安排。同稿同句重报直接用 planSource；换台词先交新方案。若用户同时要求新台词和报价，先 prepare 不传 planSource，再在本轮 deliver 新方案（narrationText=本次台词）并带该 proposalRef 绑定；未绑定不能受理。不得用旧方案引用配新台词，旧稿没有唯一原句时交付可审阅新稿。"
      + "用户明确说替换某张报价（例如降低并替换原额度）时，replacesProposal 传 read_proposal 读到的准确 proposalId/digest；只撤同事项同方案同范围的指定旧单。普通备选不填。替换额度不足返回 stale 并明确旧报价已撤、本次未就绪，不让用户回用旧高额度。"
      + "为已有视频准备新版本时，先用 read_run / read_proposal 核对上一版实际使用的输入与产出：未受影响的段落直接引用原有 blob 或产物修订作为 render 输入，只为受影响的段落新增生成操作；本会话已采用的素材同样优先复用。不为省事把所有片段重新生成，也不为复用重复安排付费操作。"
      + "该视频当前方案主稿已关联同内容提案时（例如制作终止后按原内容重提），重新准备的同内容提案会自动继承该关联，"
      + "仅授权上限变化同样继承：不要再交付新方案稿重新绑定，也不要要求用户重新认可同一份方案；新提案展示新报价，等用户明确开始。"
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
    description: "用户明确要正式做一条视频后，为这条视频建立创作事项（标题由用户内容概括）。普通 Prompt、热点讨论、单独写脚本不要调用。之后按内容 → 画面声音方案 → 视频初稿三阶段推进，每阶段等用户明确认可。",
    parameters: inlineSchema("ToolStartWork"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const work = await tools.startWork(context, args as ToolStartWork);
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id } };
    },
  };

  const readWork: ToolDefinition = {
    name: "read_work",
    label: "读取视频创作状态",
    description: "读取一条视频创作的当前阶段、各阶段主稿与已认可对象（confirmationAction 区分仅认可/认可并继续）、待更新的上游关系、关联提案与运行，并附带该视频的相关意见。回答“现在到哪一步/认可的是哪版/有哪些意见”前先用它核对事实。",
    parameters: inlineSchema("ToolReadWork"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const work = await tools.readWork(context, args as ToolReadWork);
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id, stage: work.stage, feedback: work.relatedFeedback.length } };
    },
  };

  const confirmStage: ToolDefinition = {
    name: "confirm_stage",
    label: "记录阶段认可",
    description: "只记录用户本轮明确表达的认可：approve_content（认可内容，暂停）、approve_content_continue（认可内容并进入画面阶段）、approve_plan（认可方案但暂不制作）、finalize_video（认可已存在的成片定稿）。subject 必须是当前会话真实内容来源（真实修订或本次消息原文消息）。不要因为语气接近、假设或引用别人就记录；镜头修改不包含继续认可，不能用本工具绕过改稿失败。本工具不能开始制作。",
    parameters: inlineSchema("ToolConfirmStage"),
    async execute(toolCallId, args) {
      const context = requireContext(holder, toolCallId);
      const work = await tools.confirmStage(context, args as ToolConfirmStage);
      return { content: [{ type: "text" as const, text: JSON.stringify(work) }], details: { workId: work.id, stage: work.stage } };
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

  return [readSkillFile, readArtifact, deliverArtifacts, prepareProduction, readProposal, readRun, listProduction,
    searchMaterials, readMaterialBatch, readTrends, importMaterial, startWork, readWork, confirmStage, recordWorkFeedback];
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
