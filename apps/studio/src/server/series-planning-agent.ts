import {
  CodexBridgeClient,
  roleAgentCheckpointKey,
  runRoleAgentLoop,
  validateRoleAudit,
  type CodexPreparedOperation,
  fileRoleAgentLoopCheckpoint,
} from "@video-factory/production-pipeline";
import path from "node:path";
import type { StudioPlanningOperation, StudioSeriesEpisodePlanning, StudioSeriesRoadmapOperation } from "../shared/api.js";
import { StudioConflictError } from "./studio-errors.js";
import { planningCheckpoint, readPlanningCheckpoints, isRecord as isCheckpointRecord } from "./planning-operations.js";
import type { StudioSeriesEpisode } from "../shared/api.js";
import type { SeriesEpisodeDraft } from "./series-planner.js";
import type { SeriesRecord } from "./series-store.js";

const SERIES_SHOWRUNNER_CONTRACT_VERSION = "series-showrunner-v3|role-audit-v9|series-roadmap-validator-v2|single-initial-audit-v1";
const SERIES_GREENLIGHT_CONTRACT_VERSION = "series-greenlight-v3|role-audit-v9|series-roadmap-validator-v2|single-initial-audit-v1";
const SERIES_REVISION_CONTRACT_VERSION = "series-episode-revision-v3|series-roadmap-validator-v2";

export interface SeriesPlanningResult {
  drafts: SeriesEpisodeDraft[];
  planning: StudioSeriesEpisodePlanning;
}

export interface SeriesPlanningAgent {
  generate(series: SeriesRecord, count: number): Promise<SeriesPlanningResult>;
  roadmapOperations?(series: SeriesRecord): Promise<StudioSeriesRoadmapOperation[]>;
  retrieveRoadmap?(series: SeriesRecord, operationId: string): Promise<SeriesPlanningResult>;
  observeRoadmap?(series: SeriesRecord, operationId: string): Promise<void>;
  reviewEpisode(series: SeriesRecord, episode: StudioSeriesEpisode): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }>;
  reviseEpisode(series: SeriesRecord, episode: StudioSeriesEpisode, instruction: string): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }>;
}

export class CodexSeriesPlanningAgent implements SeriesPlanningAgent {
  constructor(
    private readonly client: CodexBridgeClient,
    private readonly checkpointDirectory?: string,
    private readonly selectedModel?: () => Promise<string | undefined>,
  ) {}

  async generate(series: SeriesRecord, count: number): Promise<SeriesPlanningResult> {
    const model = await this.selectedModel?.();
    const existing = [...series.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber);
    const startEpisodeNumber = Math.max(series.nextEpisodeNumber, (existing.at(-1)?.episodeNumber ?? 0) + 1);
    const request = {
      series: {
        id: series.id,
        name: series.name,
        premise: series.premise,
        audience: series.audience,
        platform: series.platform,
        category: series.category,
        track: series.track,
        pillars: series.pillars,
        tone: series.tone,
        visualStyle: series.visualStyle,
        currentSeason: series.currentSeason,
        bible: series.bible,
        canon: series.canon,
        existingEpisodes: existing.map((episode) => ({
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          pillar: episode.pillar,
          concept: episode.concept,
          status: episode.status,
          continuity: episode.continuity,
        })),
      },
      planningWindow: { startEpisodeNumber, count },
    };
    const checkpointKey = roleAgentCheckpointKey({ request, model, contractVersion: SERIES_SHOWRUNNER_CONTRACT_VERSION });
    const originals = await this.planningRecords();
    if (originals.unassigned.length) throw new StudioConflictError(unassignedRoadmapMessage);
    // 同key进入role loop也可能为已失败的审计换代；已有操作统一沿原请求查询或取回。
    if (originals.records.some(({ owner }) => owner.kind === "series" && owner.id === series.id && owner.action === "generate")) {
      throw new StudioConflictError("已有原路线图操作，请查看候选或查询原请求；更换模型或合同也不会重新生成。");
    }
    const execution = await runRoleAgentLoop<{ episodes: SeriesEpisodeDraft[] }>({
      role: "系列总编",
      contractVersion: SERIES_SHOWRUNNER_CONTRACT_VERSION,
      criteria: [
        "路线图严格遵守 Series Bible 与当前 Canon，不把未来计划、未验证结论或人物变化冒充已发生事实",
        "本集想法回应系列创作意图，内容具体且没有与已确认要求冲突。",
        "相邻集仅引用已知的交接与事实，不把尚未定版的前集内容当成已发生事实",
        "标题、本集想法与已确认的内容支柱一致；不强制每集采用特定开场、推进与结尾。",
        "每集具备明确可见的短视频表达空间，能够在经济素材与必要的生成素材之间做逐镜选择",
        "集数连续、数量准确，且没有输入中不存在的事实、数字、经历、引用或来源",
      ],
      maxIterations: 1,
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("series-roadmap", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId, session, { ...requestOptions, ...(model ? { model } : {}) }),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["episodes title", "concept", "pillar", "fromPrevious", "toNext"],
            doesNotOwn: ["Series Bible", "已定版 Canon", "已完成前集事实", "单集脚本与成片"],
          },
          upstreamFacts: request,
          currentRoleContract: { episodeCount: count, firstEpisodeNumber: startEpisodeNumber, contiguousEpisodeNumbers: true },
          downstreamBoundary: "只规划有顺序的系列路线图；不得修改既有正史，也不得要求未来单集脚本或成片已经存在。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, session, { ...requestOptions, ...(model ? { model } : {}) }),
      validate: (value) => parseSeriesRoadmapOutput(value, series.pillars, startEpisodeNumber, count),
      ...(this.checkpointDirectory ? {
        checkpoint: planningCheckpoint(this.checkpointDirectory, checkpointKey, {
          kind: "series", id: series.id, title: series.name, action: "generate", baseRevision: series.revision,
          pillars: series.pillars, startEpisodeNumber, count,
        }),
      } : {}),
    });
    const finalAudit = execution.agentLoop?.iterations.at(-1)?.audit;
    return {
      drafts: execution.output.episodes,
      planning: {
        source: "agent",
        role: "系列总编",
        auditRole: "独立质量复核",
        auditStatus: seriesAuditStatus(execution.agentLoop?.status),
        auditIterations: execution.agentLoop?.iterations.length ?? 1,
        ...(finalAudit ? {
          auditScore: finalAudit.score,
          auditSummary: finalAudit.summary,
          ...(finalAudit.issues.length ? { auditSuggestions: finalAudit.issues.map((issue) => issue.creatorAction ?? issue.repairInstruction) } : {}),
        } : {}),
        providerId: execution.trace?.providerId ?? "openai",
        modelId: execution.trace?.modelId ?? "codex-default",
        promptVersion: execution.trace?.promptVersion ?? "video-factory/series-showrunner-v1",
        ...(execution.trace?.reasoningEffort ? { reasoningEffort: execution.trace.reasoningEffort } : {}),
      },
    };
  }

  private async planningRecords() {
    const unassigned: StudioPlanningOperation[] = [];
    const records = this.checkpointDirectory ? await readPlanningCheckpoints(this.checkpointDirectory, (operation) => unassigned.push(operation), true) : [];
    return { records, unassigned };
  }

  private async roadmapRecords(seriesId: string) {
    return (await this.planningRecords()).records
      .filter(({ owner }) => owner.kind === "series" && owner.id === seriesId && owner.action === "generate");
  }

  async roadmapOperations(series: SeriesRecord): Promise<StudioSeriesRoadmapOperation[]> {
    const { records, unassigned } = await this.planningRecords();
    return [
      ...records.filter(({ owner }) => owner.kind === "series" && owner.id === series.id && owner.action === "generate")
        .map((record) => roadmapOperation(record, series)),
      ...unassigned.map((operation): StudioSeriesRoadmapOperation => ({ ...operation,
        id: operation.id.slice(operation.id.lastIndexOf(":") + 1), message: unassignedRoadmapMessage,
        auditStatus: "unknown", canRetrieve: false, canQuery: false,
      })),
    ];
  }

  async retrieveRoadmap(series: SeriesRecord, operationId: string): Promise<SeriesPlanningResult> {
    const record = (await this.roadmapRecords(series.id)).find(({ key }) => key === operationId);
    if (!record) throw new Error("没有找到原路线图操作。");
    const operation = roadmapOperation(record, series);
    if (!operation.candidate) throw new Error("原操作尚无通过产稿合同的候选；请查询原请求。");
    if (!operation.canRetrieve) throw new Error("路线图版本已修改或采用，原候选只能查看，不能覆盖当前版本。");
    const pending = isCheckpointRecord(record.checkpoint.pendingCandidate) ? record.checkpoint.pendingCandidate : undefined;
    const last = Array.isArray(record.checkpoint.completed) ? record.checkpoint.completed.at(-1) : undefined;
    const trace = isCheckpointRecord(pending?.candidateTrace) ? pending.candidateTrace
      : isCheckpointRecord(last) && isCheckpointRecord(last.candidateTrace) ? last.candidateTrace : {};
    const audit = !pending && isCheckpointRecord(last) && isCheckpointRecord(last.audit)
      ? validateRoleAudit(last.audit, { role: "系列总编", candidate: { episodes: operation.candidate } }) : undefined;
    return { drafts: operation.candidate, planning: {
      source: "agent", role: "系列总编", auditRole: "独立质量复核", auditStatus: operation.auditStatus,
      auditIterations: Array.isArray(record.checkpoint.completed) ? record.checkpoint.completed.length : 0,
      auditSummary: operation.message,
      ...(audit ? { auditScore: audit.score, auditSuggestions: audit.issues.map((issue) => issue.creatorAction ?? issue.repairInstruction) } : {}),
      providerId: typeof trace.providerId === "string" ? trace.providerId : "unknown",
      modelId: typeof trace.modelId === "string" ? trace.modelId : "unknown",
      promptVersion: typeof trace.promptVersion === "string" ? trace.promptVersion : "unknown",
    } };
  }

  async observeRoadmap(series: SeriesRecord, operationId: string): Promise<void> {
    const record = (await this.roadmapRecords(series.id)).find(({ key }) => key === operationId);
    if (!record || !this.checkpointDirectory) throw new Error("没有找到原路线图操作。");
    const pending = record.checkpoint.pendingOperation;
    if (!isCheckpointRecord(pending) || !isCheckpointRecord(pending.operation)) return;
    const operation = pending.operation as unknown as CodexPreparedOperation;
    const observed = await this.client.observePreparedOnce(operation, { timeoutMs: 10_000 });
    if (observed.state === "query_failure") throw new Error("原请求查询未成功，已保存的候选和待核状态不变；请稍后查询。");
    if (observed.state === "conflict") throw new Error("原请求身份与服务记录不一致，已停止恢复；请核对原服务记录。");
    if (observed.state === "not_accepted") throw new Error("原服务未能确认这条已保存请求；不据此重新提交，请保留原请求核对。");
    if (observed.state === "completed_success") {
      const execution = observed.execution;
      if (pending.phase === "produce") {
        const candidate = parseSeriesRoadmapOutput(execution.output, record.owner.pillars ?? [], record.owner.startEpisodeNumber!, record.owner.count!);
        record.checkpoint.pendingCandidate = { iteration: pending.iteration, candidate, ...(execution.trace ? { candidateTrace: execution.trace } : {}) };
        delete record.checkpoint.pendingOperation;
        delete record.checkpoint.failure;
        record.checkpoint.status = "running";
      } else if (pending.phase === "audit" && isCheckpointRecord(record.checkpoint.pendingCandidate)) {
        const candidate = record.checkpoint.pendingCandidate;
        try {
          const audit = validateRoleAudit(execution.output, { role: "系列总编", candidate: candidate.candidate });
          record.checkpoint.completed = [...(Array.isArray(record.checkpoint.completed) ? record.checkpoint.completed : []),
            { ...candidate, audit, ...(execution.trace ? { auditTrace: execution.trace } : {}) }];
          delete record.checkpoint.pendingCandidate;
          delete record.checkpoint.failure;
          record.checkpoint.status = audit.verdict === "pass" ? "passed" : "awaiting_user";
        } catch {
          record.checkpoint.status = "failed";
          record.checkpoint.failure = { stage: "completed_failure", summary: "原审计已返回，但未通过审计合同；候选保留。", details: execution.trace };
        }
        delete record.checkpoint.pendingOperation;
      }
    } else if (observed.state === "completed_failure") {
      record.checkpoint.failure = { stage: observed.error.stage, summary: observed.error.creatorMessage,
        ...(observed.error.failureDetails ? { details: observed.error.failureDetails } : {}) };
      record.checkpoint.status = "failed";
      delete record.checkpoint.pendingOperation;
    } else return;
    // 只查询原请求，绝不进入loop并启动下一阶段或换代请求。
    if (record.checkpoint.planningOwner === undefined) record.checkpoint.planningOriginalOperation = operation;
    await fileRoleAgentLoopCheckpoint(path.join(this.checkpointDirectory, `${record.key}.json`), record.key).save(record.checkpoint);
  }

  async reviewEpisode(
    series: SeriesRecord,
    episode: StudioSeriesEpisode,
  ): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }> {
    const model = await this.selectedModel?.();
    const request = {
      series: seriesPlanningContext(series),
      planningWindow: { startEpisodeNumber: episode.episodeNumber, count: 1, mode: "greenlight" },
      targetEpisode: {
        ...episodeDraft(episode),
        inheritedFromPrevious: [...(episode.continuity.inheritedFromPrevious ?? [])],
      },
    };
    // 同一修订恢复原审计；审计写入后系列 revision 前进，下一次主动审计必须是新操作。
    const checkpointKey = roleAgentCheckpointKey({ request, model, contractVersion: SERIES_GREENLIGHT_CONTRACT_VERSION, seriesRevision: series.revision });
    const execution = await runRoleAgentLoop<{ episodes: SeriesEpisodeDraft[] }>({
      role: "系列开拍总编",
      contractVersion: SERIES_GREENLIGHT_CONTRACT_VERSION,
      criteria: [
        "本集严格遵守最新 Series Bible 与 Canon，不把预告、计划、悬念或尚待验证的内容冒充正史",
        "本集与前集正式交接和连续性记忆相容，保留用户想表达的内容",
        "标题、本集想法、支柱和本季篇章一致",
        "保留人工明确决定；只有与最新正史或硬约束冲突时才修订，并说明可执行的修复",
        "fromPrevious 是创作者拥有的本集承接要求，必须与输入逐字逐项一致；只能修改 Agent 拥有的其他规划字段",
        "画面表达可实现，事实、数字、人物状态、引用和来源没有凭空新增",
      ],
      maxIterations: 1,
      initialCandidate: { episodes: [episodeDraft(episode)] },
      produce: (revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("series-roadmap", {
        ...request,
        ...(revision ? { revision } : {}),
      }, requestId, session, { ...requestOptions, ...(model ? { model } : {}) }),
      audit: ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["targetEpisode 中除 fromPrevious 外的规划字段"],
            doesNotOwn: ["Series Bible", "已定版 Canon", "fromPrevious", "单集脚本与成片"],
          },
          upstreamFacts: request,
          currentRoleContract: { episodeCount: 1, episodeNumber: episode.episodeNumber, preserveFromPreviousExactly: true },
          downstreamBoundary: "只做本集开拍前绿灯审计；不得修改创作者确认的承接要求，也不得要求脚本或成片已生成。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
      }, requestId, session, { ...requestOptions, ...(model ? { model } : {}) }),
      validate: (value) => {
        const parsed = parseSeriesRoadmapOutput(value, series.pillars, episode.episodeNumber, 1);
        if (JSON.stringify(parsed.episodes[0]?.fromPrevious) !== JSON.stringify(episode.continuity.fromPrevious)) {
          throw new Error("Series greenlight agent changed creator-owned fromPrevious requirements.");
        }
        return parsed;
      },
      ...(this.checkpointDirectory ? {
        checkpoint: planningCheckpoint(this.checkpointDirectory, checkpointKey, {
          kind: "series", id: series.id, title: series.name, action: "audit", baseRevision: series.revision,
          episodeNumber: episode.episodeNumber,
        }),
      } : {}),
    });
    const finalIteration = execution.agentLoop?.iterations.at(-1);
    const trace = execution.trace ?? finalIteration?.auditTrace;
    const draft = execution.output.episodes[0]!;
    return {
      draft,
      planning: {
        source: episode.planning.source === "human" ? "human" : "agent",
        role: "系列开拍总编",
        auditRole: "独立质量复核",
        auditStatus: seriesAuditStatus(execution.agentLoop?.status),
        auditIterations: execution.agentLoop?.iterations.length ?? 1,
        ...(finalIteration ? {
          auditScore: finalIteration.audit.score,
          auditSummary: finalIteration.audit.summary,
          ...(finalIteration.audit.issues.length
            ? { auditSuggestions: finalIteration.audit.issues.map((issue) => issue.creatorAction ?? issue.repairInstruction) }
            : {}),
        } : {}),
        providerId: trace?.providerId ?? "openai",
        modelId: trace?.modelId ?? "codex-default",
        promptVersion: trace?.promptVersion ?? "video-factory/series-greenlight-v1",
        ...(trace?.reasoningEffort ? { reasoningEffort: trace.reasoningEffort } : {}),
      },
    };
  }

  async reviseEpisode(
    series: SeriesRecord,
    episode: StudioSeriesEpisode,
    instruction: string,
  ): Promise<{ draft: SeriesEpisodeDraft; planning: StudioSeriesEpisodePlanning }> {
    const model = await this.selectedModel?.();
    const request = {
      series: seriesPlanningContext(series),
      planningWindow: { startEpisodeNumber: episode.episodeNumber, count: 1, mode: "revise" },
      targetEpisode: {
        ...episodeDraft(episode),
        inheritedFromPrevious: [...(episode.continuity.inheritedFromPrevious ?? [])],
      },
      revision: { instruction },
    };
    // 不可变版本用于宿主恢复身份，不是模型应改写的创作字段；不能泄漏进严格的 targetEpisode 合同。
    const checkpointKey = roleAgentCheckpointKey({ request, model, contentVersionId: episode.contentVersionId, contractVersion: SERIES_REVISION_CONTRACT_VERSION });
    const execution = await runRoleAgentLoop<{ episodes: SeriesEpisodeDraft[] }>({
      role: "系列总编",
      contractVersion: SERIES_REVISION_CONTRACT_VERSION,
      criteria: ["只修改当前单集，不改写已确认 Series Bible、Canon 和创作者填写的 fromPrevious。"],
      maxIterations: 1,
      deferAudit: true,
      produce: (_revision, { requestId, session, requestOptions, preparedOperation }) => preparedOperation
        ? this.client.observePrepared(preparedOperation, requestOptions)
        : this.client.runTaskDetailed("series-roadmap", request, requestId, session, { ...requestOptions, ...(model ? { model } : {}) }),
      audit: () => { throw new Error("单集修订不得自动审计。"); },
      validate: (value) => {
        const parsed = parseSeriesRoadmapOutput(value, series.pillars, episode.episodeNumber, 1);
        if (JSON.stringify(parsed.episodes[0]?.fromPrevious) !== JSON.stringify(episode.continuity.fromPrevious)) {
          throw new Error("单集修订不能改写创作者填写的承接要求。");
        }
        return parsed;
      },
      ...(this.checkpointDirectory ? {
        checkpoint: planningCheckpoint(this.checkpointDirectory, checkpointKey, {
          kind: "series", id: series.id, title: series.name, action: "revise", baseRevision: series.revision,
          episodeNumber: episode.episodeNumber,
        }),
      } : {}),
    });
    return {
      draft: execution.output.episodes[0]!,
      planning: {
        source: "agent", role: "系列总编", auditRole: "独立质量复核",
        auditStatus: "not_audited", auditIterations: 0,
        providerId: execution.trace?.providerId ?? "openai",
        modelId: execution.trace?.modelId ?? "codex-default",
        promptVersion: execution.trace?.promptVersion ?? "video-factory/series-episode-revision-v1",
        ...(execution.trace?.reasoningEffort ? { reasoningEffort: execution.trace.reasoningEffort } : {}),
      },
    };
  }
}

const unassignedRoadmapMessage = "存在无法核对业务归属的历史系列请求，已暂停模型生成，避免重复调用。请核对费用记录中的原请求；当前稿仍可手工编辑。";

function roadmapOperation(record: Awaited<ReturnType<typeof readPlanningCheckpoints>>[number], series: SeriesRecord): StudioSeriesRoadmapOperation {
  const { checkpoint, owner, operation } = record;
  const last = Array.isArray(checkpoint.completed) ? checkpoint.completed.at(-1) : undefined;
  const saved = isCheckpointRecord(checkpoint.pendingCandidate) ? checkpoint.pendingCandidate : isCheckpointRecord(last) ? last : undefined;
  let candidate: SeriesEpisodeDraft[] | undefined;
  if (saved && Number.isSafeInteger(owner.startEpisodeNumber) && Number.isSafeInteger(owner.count)) {
    try { candidate = parseSeriesRoadmapOutput(saved.candidate, owner.pillars ?? [], owner.startEpisodeNumber!, owner.count!).episodes; }
    catch { /* 当前产稿合同不接受的旧候选只能保留原记录，不能交付。 */ }
  }
  const failure = isCheckpointRecord(checkpoint.failure) ? checkpoint.failure : undefined;
  const auditStatus = checkpoint.status === "passed" ? "passed" : checkpoint.status === "awaiting_user" ? "awaiting_user"
    : failure?.stage === "uncertain" || isCheckpointRecord(checkpoint.pendingOperation) ? "unknown"
    : checkpoint.status === "failed" ? "failed" : "not_audited";
  const audit = isCheckpointRecord(last) && isCheckpointRecord(last.audit) ? last.audit : undefined;
  const message = auditStatus === "passed" || auditStatus === "awaiting_user"
    ? typeof audit?.summary === "string" ? audit.summary : "原审计已完成。"
    : auditStatus === "failed" ? candidate ? "独立审计失败，已生成的候选保留；取回不等于审计通过或采用。" : "生成未交付合法候选。原操作已保留，可核对请求及费用；当前规则稿仍可手工编辑。"
    : auditStatus === "unknown" ? "原请求结果待核；只查询原请求，不重新生成。" : "候选尚未审计；取回后由你决定。";
  return { ...operation, auditStatus, message, ...(candidate ? { candidate } : {}), canQuery: true,
    canRetrieve: !!candidate && owner.baseRevision === series.revision
      && series.episodes.every((episode) => episode.status === "planned" && episode.planning.source === "rules" && !episode.runId && !episode.runReservation),
  };
}

function seriesPlanningContext(series: SeriesRecord) {
  return {
    id: series.id,
    name: series.name,
    premise: series.premise,
    audience: series.audience,
    platform: series.platform,
    category: series.category,
    track: series.track,
    pillars: series.pillars,
    tone: series.tone,
    visualStyle: series.visualStyle,
    currentSeason: series.currentSeason,
    bible: series.bible,
    canon: series.canon,
    existingEpisodes: [...series.episodes]
      .sort((left, right) => left.episodeNumber - right.episodeNumber)
      .map((candidate) => ({
        episodeNumber: candidate.episodeNumber,
        title: candidate.title,
        pillar: candidate.pillar,
        concept: candidate.concept,
        status: candidate.status,
        continuity: candidate.continuity,
      })),
  };
}

function episodeDraft(episode: StudioSeriesEpisode): SeriesEpisodeDraft {
  return {
    episodeNumber: episode.episodeNumber,
    pillar: episode.pillar,
    title: episode.title,
    concept: episode.concept,
    fromPrevious: [...episode.continuity.fromPrevious],
    toNext: [...episode.continuity.toNext],
  };
}

export function parseSeriesRoadmapOutput(
  value: unknown,
  allowedPillars: string[],
  startEpisodeNumber: number,
  count: number,
): { episodes: SeriesEpisodeDraft[] } {
  if (!isRecord(value) || !Array.isArray(value.episodes) || value.episodes.length !== count) {
    throw new Error(`Series roadmap output must contain exactly ${count} episodes.`);
  }
  const episodes = value.episodes.map((entry, index): SeriesEpisodeDraft => {
    if (!isRecord(entry)) throw new Error(`Series roadmap episode ${index + 1} must be an object.`);
    const episodeNumber = integer(entry.episodeNumber, `episode ${index + 1} number`);
    if (episodeNumber !== startEpisodeNumber + index) throw new Error("Series roadmap episode numbers must match the requested window.");
    const pillar = text(entry.pillar, `episode ${episodeNumber} pillar`);
    if (allowedPillars.length > 0 && !allowedPillars.includes(pillar)) throw new Error(`Series roadmap episode ${episodeNumber} uses an unknown pillar.`);
    return {
      episodeNumber,
      pillar,
      title: text(entry.title, `episode ${episodeNumber} title`),
      concept: text(entry.concept, `episode ${episodeNumber} concept`),
      fromPrevious: textArray(entry.fromPrevious, `episode ${episodeNumber} fromPrevious`),
      toNext: textArray(entry.toNext, `episode ${episodeNumber} toNext`),
    };
  });
  if (new Set(episodes.map((episode) => episode.title)).size !== episodes.length) {
    throw new Error("Series roadmap episode titles must be distinct.");
  }
  if (new Set(episodes.map((episode) => episode.concept)).size !== episodes.length) {
    throw new Error("Series roadmap episode concepts must be distinct.");
  }
  return { episodes };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new Error(`${label} is invalid.`);
  return value.trim();
}

function textArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error(`${label} is invalid.`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 审计真实结论落到单集记录上。轮次跑完仍未判 pass 时循环停在 awaiting_user，它照常返回候选，
 * 所以这里过去无条件写 "passed" 会把"审计明确要求修复"谎报成"3/3 轮通过"——用户据此放行的
 * 是一份审计自己没认可的方案。审计只出建议，但建议必须如实呈现，不能替它宣布通过。
 */
function seriesAuditStatus(status: string | undefined): StudioSeriesEpisodePlanning["auditStatus"] {
  return status === "passed" ? "passed" : "awaiting_user";
}
