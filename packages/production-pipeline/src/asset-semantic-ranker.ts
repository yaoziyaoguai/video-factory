import { createHash } from "node:crypto";
import type { CodexBridgeClient, CodexPreparedOperation, CodexTaskExecution } from "./codex-chat.js";
import { pendingRoleAgentOperation } from "./role-agent-checkpoint.js";
import { RoleAgentHostStop, RoleAgentLoopError, RoleAgentNoProgressError, runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

export interface AssetCandidate {
  provider: string;
  providerId?: string;
  assetId: string;
  mediaType: "image" | "video";
  width: number;
  height: number;
  duration: number;
  previewUrl: string;
  sourceUrl: string;
  creator: string;
  licenseNote: string;
  query: string;
  qualityScore: number;
}

export interface AssetCandidateScene {
  scenePosition: number;
  intent: Record<string, string>;
  query: string;
  candidates: AssetCandidate[];
}

export interface AssetCandidateReport {
  version: "video-factory/asset-candidates-v1";
  scenes: AssetCandidateScene[];
}

export interface AssetRankingCandidate {
  provider: string;
  assetId: string;
  originalRank: number;
  rank: number;
  semanticScore: number;
  rationale: string;
  locked: boolean;
}

export interface AssetRankingScene {
  scenePosition: number;
  summary: string;
  candidates: AssetRankingCandidate[];
}

export interface AssetSemanticRanking {
  version: "video-factory/asset-ranking-v1";
  source: "model" | "fallback";
  providerId: string;
  modelId: string;
  summary: string;
  scenes: AssetRankingScene[];
  fallbackReason?: string;
  /** 宿主从通过独立审查的实际图像快照生成，不能信任模型自报的“已看过”。 */
  visualEvidence?: {
    reportDigest: string;
    supplementaryBatches: 0 | 1;
    stopReason?: "deadline";
    reviewed: Array<Omit<AssetRankThumbnail, "jpegBase64">>;
  };
}

export interface AssetSemanticRanker {
  readonly id: string;
  readonly modelId: string;
  rank(report: AssetCandidateReport): Promise<AssetSemanticRanking>;
  rankDetailed?(report: AssetCandidateReport, checkpoint?: RoleAgentLoopCheckpoint, selectedModelId?: string, canStartSupplement?: () => Promise<boolean>): Promise<CodexTaskExecution<AssetSemanticRanking>>;
}

export interface CodexAssetSemanticRankerOptions {
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed" | "observePrepared">>;
  providerId?: string;
  modelId?: string;
  fetchThumbnail?: (url: string) => Promise<Buffer | undefined>;
  maxReviewIterations?: number;
}

interface AssetRankThumbnail {
  scenePosition: number;
  provider: string;
  assetId: string;
  sha256: string;
  jpegBase64: string;
}

const MAX_RANK_THUMBNAILS = 12;
const MAX_THUMBNAIL_ATTEMPTS = 24;
const THUMBNAIL_COLLECTION_MS = 20_000;
const RANKING_DEADLINE_MS = 10 * 60_000;
const MAX_RANK_PAYLOAD_BYTES = 8 * 1024 * 1024;
// 与 Broker 的逐图边界保持一致，避免在模型调用前被协议层拒绝。
const MAX_THUMBNAIL_BYTES = 256 * 1024;
/**
 * base64 的长度上界必须由字节上界换算而来，不能沿用给短标签定的 2_000 字符上限：
 * 写入侧放行到 MAX_THUMBNAIL_BYTES，读取侧却只认 1_500 字节的图，结果就是"写得进去、
 * 读不回来"——真实缩略图 30–80 KB，于是每一次恢复已存盘的 asset-rank 操作都必然失败。
 * ceil(n/3)*4 是 base64 的精确长度上界。
 */
const MAX_THUMBNAIL_BASE64_CHARS = Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4;
const THUMBNAIL_HOSTS = new Set(["images.pexels.com", "cdn.pixabay.com", "images.unsplash.com"]);
export const ASSET_RANK_AGENT_CONTRACT_VERSION = "asset-rank-v3|role-audit-v9|asset-ranking-validator-v2-bounded-evidence";

type RankPayload = AssetCandidateReport & { thumbnails: AssetRankThumbnail[] };
interface RankBatchState {
  version: "asset-rank-batches-v1";
  inputDigest: string;
  deadlineAt: number;
  phase: "primary" | "supplement";
  payload: RankPayload;
  primary?: CodexTaskExecution<AssetSemanticRanking>;
  primaryCheckpoint?: Record<string, unknown>;
  finished?: CodexTaskExecution<AssetSemanticRanking>;
}

export class CodexAssetSemanticRanker implements AssetSemanticRanker {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: CodexAssetSemanticRankerOptions) {
    this.id = options.providerId ?? "codex-asset-ranker-v1";
    this.modelId = options.modelId ?? "codex-default";
  }

  async rank(report: AssetCandidateReport): Promise<AssetSemanticRanking> {
    const payload = await this.rankPayload(report);
    return validateAssetSemanticRanking(await this.options.client.runTask("asset-rank", payload), report);
  }

  async rankDetailed(report: AssetCandidateReport, checkpoint?: RoleAgentLoopCheckpoint, selectedModelId?: string, canStartSupplement?: () => Promise<boolean>): Promise<CodexTaskExecution<AssetSemanticRanking>> {
    report = structuredClone(report);
    if (!this.options.client.runTaskDetailed) throw new Error("Audited asset ranking requires a detailed client; refusing unaudited fallback.");
    let stored = checkpoint ? await checkpoint.load() : undefined;
    const saved = isRecord(stored) ? stored.assetRankBatch : undefined;
    const inputDigest = digest({ report, model: selectedModelId ?? this.modelId, provider: this.id });
    const pending = await pendingRoleAgentOperation(checkpoint, ["asset-rank", "role-audit"]);
    let batch: RankBatchState;
    if (saved !== undefined) {
      batch = parseRankBatch(saved, inputDigest, report);
    } else {
      const recovered = pending ? recoveredAssetRankPayload(pending, report) : undefined;
      batch = {
        version: "asset-rank-batches-v1", inputDigest, deadlineAt: Date.now() + RANKING_DEADLINE_MS,
        phase: "primary", payload: recovered ?? await this.rankPayload(report),
      };
      // 旧已完成循环没有可核对的图像快照，不能下载新图后把旧裁决当成新图的审查。
      // 旧 pending 则必须原地观察，绝不因为升级丢掉已提交请求。
      if (!pending) stored = undefined;
    }
    const persist = async (value: unknown) => {
      const next = { ...(isRecord(value) ? value : {}), assetRankBatch: batch };
      await checkpoint?.save(next);
      stored = structuredClone(next);
    };
    if (batch.finished) return structuredClone(batch.finished);
    await persist(stored);
    const finishDeadline = async (execution: CodexTaskExecution<AssetSemanticRanking>, noProgress = false) => {
      const summary = "候选画面复核已达到本次时间上限；保留已核验结果，未通过核验的候选不自动采用，请选择下一步。"
        + (noProgress ? "最后一次修改未改变候选，原候选和复核意见已保留。" : "");
      batch.finished = { ...execution, output: { ...execution.output, summary, visualEvidence: {
        reportDigest: reportDigest(report), reviewed: execution.output.visualEvidence?.reviewed ?? [],
        supplementaryBatches: batch.phase === "supplement" ? 1 : 0, stopReason: "deadline",
      } } };
      await persist(stored);
      return batch.finished;
    };
    const execute = async () => {
      const key = batch.phase === "primary" ? checkpoint?.key ?? inputDigest : `${checkpoint?.key ?? inputDigest}:supplement:${digest(batch.payload)}`;
      const localCheckpoint: RoleAgentLoopCheckpoint = {
        ...checkpoint, key,
        load: async () => isRecord(stored) && typeof stored.version === "string" ? stored : undefined,
        save: persist,
      };
      try {
        return await this.rankBatchDetailed(batch.payload, localCheckpoint, selectedModelId, batch.deadlineAt, report, canStartSupplement);
      } catch (error) {
        if (!(error instanceof RoleAgentLoopError)) throw error;
        const deadlineStop = error.sourceError instanceof RoleAgentHostStop && error.sourceError.reason === "deadline";
        const settledLateFailure = Date.now() >= batch.deadlineAt
          && (error.agentLoop.failure?.stage === "completed_failure" || error.sourceError instanceof RoleAgentNoProgressError)
          && !(isRecord(stored) && isRecord(stored.pendingOperation));
        if (!deadlineStop && !settledLateFailure) throw error;
        // 迟到结果已经由循环落盘。只交付此前审过的证据，未审候选保留在checkpoint供排查，
        // 不能为赶进度放行；同输入重放此人工停点，不自动重置时间或补看额度。
        const baseline = batch.primary?.output ?? deterministicAssetRanking(report, error.message);
        return finishDeadline({
          output: baseline,
          agentLoop: combineAgentLoops(batch.primary?.agentLoop, error.agentLoop)!,
        }, error.sourceError instanceof RoleAgentNoProgressError);
      }
    };
    if (batch.phase === "primary") {
      const primary = await execute();
      if (batch.finished) return primary;
      primary.output = withVisualEvidence(primary, batch.payload, report, 0);
      if (Date.now() >= batch.deadlineAt) return finishDeadline({ ...primary,
        output: primary.agentLoop?.status === "passed" ? primary.output : deterministicAssetRanking(report),
      });
      if (primary.agentLoop && primary.agentLoop.status !== "passed") {
        if (primary.agentLoop.status === "awaiting_user") {
          batch.finished = primary;
          await persist(stored);
          return primary;
        }
        throw new RoleAgentLoopError("候选排序尚未通过独立审查，停止自动采用与补证，等待处理审查意见。", primary.agentLoop, primary.trace);
      }
      await assertRankingNotPaused(canStartSupplement);
      if (Date.now() >= batch.deadlineAt) {
        return finishDeadline(primary);
      }
      const reviewed = new Set(primary.output.visualEvidence!.reviewed.map(evidenceKey));
      const blocked = new Set(primary.output.scenes.filter(scene => scene.candidates.length > 0
        && !scene.candidates.some(candidate => candidate.semanticScore >= 40 || candidate.locked))
        .map(scene => scene.scenePosition));
      const scenes = report.scenes.filter(scene => blocked.has(scene.scenePosition));
      const unseen: AssetCandidateReport = { version: report.version, scenes: scenes.map(scene => ({
        ...scene, candidates: scene.candidates.filter(candidate => !reviewed.has(evidenceKey({ ...candidate, scenePosition: scene.scenePosition }))),
      })) };
      const thumbnails = Date.now() < batch.deadlineAt
        ? await collectRankThumbnails(unseen, this.options.fetchThumbnail ?? downloadCandidateThumbnail) : [];
      await assertRankingNotPaused(canStartSupplement);
      if (Date.now() >= batch.deadlineAt) return finishDeadline(primary);
      if (!thumbnails.length || Date.now() >= batch.deadlineAt) {
        batch.finished = primary;
        await persist(stored);
        return primary;
      }
      const included = new Set(thumbnails.map(thumbnail => thumbnail.scenePosition));
      // 保存一次性补证额度及快照后，才能创建其生产/审查请求。镜号和候选全集不变。
      const { assetRankBatch: _batch, ...primaryCheckpoint } = isRecord(stored) ? stored : {};
      batch = { ...batch, phase: "supplement", primary, primaryCheckpoint,
        payload: { version: report.version, scenes: scenes.filter(scene => included.has(scene.scenePosition)), thumbnails } };
      await persist(undefined);
    }
    const primary = batch.primary!;
    let supplemental: CodexTaskExecution<AssetSemanticRanking>;
    try {
      supplemental = await execute();
    } catch (error) {
      if (error instanceof RoleAgentLoopError) {
        throw new RoleAgentLoopError(error.message, combineAgentLoops(primary.agentLoop, error.agentLoop)!, error.lastTrace, error.sourceError);
      }
      throw error;
    }
    if (batch.finished) return supplemental;
    supplemental.output = withVisualEvidence(supplemental, batch.payload, batch.payload, 1);
    // 审查未通过时不合并任何新分数；保留审查状态，让既有人工边界处理意见。
    const output = supplemental.agentLoop?.status === "passed"
      ? mergeSupplement(primary.output, supplemental.output, report)
      : { ...primary.output, visualEvidence: { ...primary.output.visualEvidence!, supplementaryBatches: 1 as const } };
    batch.finished = { ...supplemental, output, agentLoop: combineAgentLoops(primary.agentLoop, supplemental.agentLoop)! };
    if (Date.now() >= batch.deadlineAt) return finishDeadline(batch.finished);
    await persist(stored);
    return batch.finished;
  }

  private async rankBatchDetailed(report: RankPayload, checkpoint: RoleAgentLoopCheckpoint, selectedModelId: string | undefined, deadlineAt: number, contextReport: AssetCandidateReport, canSubmit?: () => Promise<boolean>): Promise<CodexTaskExecution<AssetSemanticRanking>> {
    const client = this.options.client;
    if (typeof client.runTaskDetailed !== "function") return { output: await this.rank(report) };
    const runTaskDetailed = client.runTaskDetailed.bind(client);
    const observePrepared = typeof client.observePrepared === "function" ? client.observePrepared.bind(client) : undefined;
    const pendingOperation = await pendingRoleAgentOperation(checkpoint, ["asset-rank", "role-audit"]);
    const recoveredPayload = pendingOperation ? recoveredAssetRankPayload(pendingOperation, report) : undefined;
    if (recoveredPayload && digest(recoveredPayload.thumbnails) !== digest(report.thumbnails)) {
      throw new Error("Pending ranking operation does not match its persisted image snapshot; refusing a replacement submission.");
    }
    const payload = rankModelPayload(recoveredPayload ?? report, contextReport);
    return runRoleAgentLoop({
      role: "候选画面复核",
      contractVersion: ASSET_RANK_AGENT_CONTRACT_VERSION,
      criteria: [
        "逐镜候选完整保留，排名和原始排名均连续且没有重复",
        "排序理由引用可见证据或明确承认证据不足，不根据 URL、作者或素材 ID 臆测",
        "先确认核心主体、动作和证据职责匹配，再比较识别速度、必要信息可见性、裁切适配与邻镜关系；清晰度、漂亮程度和视觉刺激不能补偿不匹配，也不能使缺证据候选跨过自动采用阈值。",
        "对已有合格候选的镜头，首选候选的核心主体、物体和动作必须与导演意图一致；没有合格候选时必须诚实标记无匹配，并把所有不合格候选评分保持在自动执行阈值以下，这种排序结果本身可以通过审计；输入候选为空时只需如实标记无可排序项，由下游素材路由决定生成、复用或停住",
        "没有把候选锁定，也没有新增、删除或替换候选素材",
      ],
      maxIterations: this.options.maxReviewIterations ?? 3,
      produce: async (revision, { requestId, session, requestOptions, preparedOperation }) => {
        if (preparedOperation) {
          if (!observePrepared) throw new Error("Codex asset ranker cannot recover a prepared operation with this client.");
          return observePrepared(preparedOperation, requestOptions);
        }
        await assertRankingNotPaused(canSubmit);
        boundedPayload("role-audit", { context: rankAuditContext(payload) });
        return runTaskDetailed("asset-rank", boundedPayload("asset-rank", {
        ...payload,
        ...(revision ? { revision } : {}),
        }), requestId, session, { ...requestOptions, beforeSubmit: async operation => {
          await assertRankingNotPaused(canSubmit);
          remainingTime(deadlineAt);
          await requestOptions.beforeSubmit?.(operation);
        }, timeoutMs: remainingTime(deadlineAt), ...(selectedModelId ? { model: selectedModelId } : {}) });
      },
      audit: async ({ role, iteration, criteria, candidate, previousAudit, validationFailure, requestId, session, requestOptions, preparedOperation }) => {
        if (preparedOperation) {
          if (!observePrepared) throw new Error("Codex asset ranker cannot recover a prepared audit with this client.");
          return observePrepared(preparedOperation, requestOptions);
        }
        await assertRankingNotPaused(canSubmit);
        return runTaskDetailed("role-audit", boundedPayload("role-audit", {
        role,
        iteration,
        criteria,
        context: rankAuditContext(payload),
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        ...(validationFailure ? { validationFailure } : {}),
        images: payload.thumbnails.map((thumbnail, index) => ({
          imageIndex: index + 1,
          scenePosition: thumbnail.scenePosition,
          provider: thumbnail.provider,
          assetId: thumbnail.assetId,
          sha256: thumbnail.sha256,
          jpegBase64: thumbnail.jpegBase64,
        })),
        }), requestId, session, { ...requestOptions, beforeSubmit: async operation => {
          await assertRankingNotPaused(canSubmit);
          remainingTime(deadlineAt);
          await requestOptions.beforeSubmit?.(operation);
        }, timeoutMs: remainingTime(deadlineAt), ...(selectedModelId ? { model: selectedModelId } : {}) });
      },
      validate: (value) => {
        const ranking = validateAssetSemanticRanking(value, report);
        const visible = new Set(report.thumbnails.map(evidenceKey));
        for (const scene of ranking.scenes) for (const candidate of scene.candidates) {
          if (candidate.semanticScore >= 40 && !visible.has(evidenceKey({ ...candidate, scenePosition: scene.scenePosition }))) {
            throw new Error("Unseen candidates cannot cross the automatic-use threshold.");
          }
        }
        return ranking;
      },
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  private async rankPayload(report: AssetCandidateReport): Promise<AssetCandidateReport & { thumbnails: AssetRankThumbnail[] }> {
    return {
      // report 可能带有只用于 checkpoint 身份的 planningIntent；Broker 的严格合同只接收
      // 公开候选字段，必须在边界处显式投影，避免恢复路径把内部元数据泄漏进请求。
      version: report.version,
      scenes: report.scenes,
      thumbnails: await collectRankThumbnails(report, this.options.fetchThumbnail ?? downloadCandidateThumbnail),
    };
  }
}

// 补证只缩小候选范围，不缩小创作合同。通过 Broker 既有 intent 字符串字段传递导演要求与
// 邻镜语义；checkpoint 专用 planningIntent 仍不能作为协议顶层字段发送。
function rankModelPayload(payload: RankPayload, contextReport: AssetCandidateReport): RankPayload {
  const planning = (contextReport as AssetCandidateReport & { planningIntent?: unknown }).planningIntent;
  const director = isRecord(planning) ? planning.rankingIntent : undefined;
  const scenes = payload.scenes.map(scene => {
    const related = new Set([scene.scenePosition - 1, scene.scenePosition, scene.scenePosition + 1]);
    if (isRecord(director) && Array.isArray(director.shots)) {
      // 引用可以跨镜头距离；只补齐依赖闭包，不把无关全片上下文复制到每个镜头。
      for (let pass = 0; pass < director.shots.length; pass++) {
        const before = related.size;
        for (const shot of director.shots) if (isRecord(shot) && typeof shot.scenePosition === "number" && related.has(shot.scenePosition)) {
          for (const key of ["referenceFromScenePosition", "reuseFromScenePosition"]) {
            if (typeof shot[key] === "number") related.add(shot[key]);
          }
        }
        if (related.size === before) break;
      }
    }
    return { ...scene, intent: {
    ...scene.intent,
    rankingContext: JSON.stringify({
      ...(director === undefined ? {} : { director: isRecord(director) && Array.isArray(director.shots)
        ? { planContract: director.planContract, shots: director.shots.filter(shot => isRecord(shot)
          && typeof shot.scenePosition === "number" && related.has(shot.scenePosition)) }
        : director }),
      neighbors: contextReport.scenes.filter(other => Math.abs(other.scenePosition - scene.scenePosition) === 1)
        .map(other => ({ scenePosition: other.scenePosition, intent: other.intent })),
    }),
  } };
  });
  return { version: payload.version, scenes, thumbnails: payload.thumbnails };
}

function recoveredAssetRankPayload(
  operation: CodexPreparedOperation,
  report: AssetCandidateReport,
): (AssetCandidateReport & { thumbnails: AssetRankThumbnail[] }) | undefined {
  const envelopePayload = record(operation.envelope.payload, "saved asset-rank payload");
  const rawThumbnails = operation.kind === "asset-rank"
    ? envelopePayload.thumbnails
    : envelopePayload.images;
  if (!Array.isArray(rawThumbnails)) return undefined;
  const thumbnails = rawThumbnails.map((value, index): AssetRankThumbnail => {
    const item = record(value, `saved asset-rank thumbnail ${index}`);
    return {
      scenePosition: integer(item.scenePosition, "saved asset-rank scenePosition", 1),
      provider: text(item.provider, "saved asset-rank provider"),
      assetId: text(item.assetId, "saved asset-rank assetId"),
      sha256: text(item.sha256, "saved asset-rank sha256"),
      jpegBase64: thumbnailJpegBase64(item.jpegBase64, "saved asset-rank jpegBase64"),
    };
  });
  validateThumbnails(thumbnails, report);
  return { version: report.version, scenes: report.scenes, thumbnails };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function evidenceKey(value: { scenePosition: number; provider: string; assetId: string }): string {
  return JSON.stringify([value.scenePosition, value.provider, value.assetId]);
}

function reportDigest(report: AssetCandidateReport): string {
  return digest({ version: report.version, scenes: report.scenes });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rankAuditContext(payload: RankPayload) {
  return {
    roleScope: { owns: ["候选排序", "semanticScore", "rationale"], doesNotOwn: ["新增候选", "删除候选", "下载素材", "锁定人工选择"] },
    upstreamFacts: { version: payload.version, scenes: payload.scenes },
    currentRoleContract: {
      preserveEveryCandidate: true, ranksStartAtOneAndAreUnique: true, lockedMustRemainFalse: true,
      automaticUseMinimumSemanticScore: 40,
      noMatchPolicy: "所有候选都不满足核心主体、物体和动作时，完整保留并相对排序、全部低于 40、明确标记低于推荐标准；排序结果本身可以通过审计。素材能否采用由宿主核对用户确认范围、用途与费用，不得为推进流程抬高分数或更改创作要求。",
    },
    downstreamBoundary: "只排序已有候选；不得要求尚未下载的原文件或后续成片作为当前节点通过证据。",
  };
}

function boundedPayload<T>(kind: "asset-rank" | "role-audit", payload: T): T {
  const check = (value: unknown, field: string, maximum: number) => {
    if (value !== undefined && Buffer.byteLength(JSON.stringify(value)) > maximum) {
      throw new RoleAgentHostStop("payload_limit", `候选核验资料超过接口的 ${field} 容量限制，未提交模型。请缩小本次画面方案后再确认；不会自动截掉候选或导演要求。`);
    }
  };
  check(payload, "payload", MAX_RANK_PAYLOAD_BYTES);
  if (isRecord(payload)) {
    const limits = kind === "asset-rank" ? { scenes: 192 * 1024, revision: 192 * 1024 }
      : { context: 192 * 1024, candidate: 192 * 1024, previousAudit: 64 * 1024 };
    for (const [field, maximum] of Object.entries(limits)) check(payload[field], field, maximum);
    if (isRecord(payload.validationFailure)) {
      check(payload.validationFailure.invalidCandidate, "validationFailure.invalidCandidate", 64 * 1024);
      if (typeof payload.validationFailure.validationError === "string" && payload.validationFailure.validationError.length > 300) {
        throw new RoleAgentHostStop("payload_limit", "核验诊断超过接口容量，未提交修复请求；请调整画面方案后再确认。");
      }
    }
  }
  return payload;
}

function remainingTime(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new RoleAgentHostStop("deadline", "本轮候选核验时间已用尽，已收回的结果保留，未审查素材不会自动采用。请在导演讨论中调整画面要求或补充素材后再确认；也可以停止本次制作。");
  return remaining;
}

async function assertRankingNotPaused(canSubmit?: () => Promise<boolean>): Promise<void> {
  if (canSubmit && !await canSubmit()) throw new RoleAgentHostStop("paused", "已暂停候选核验，已完成结果保留；恢复后继续尚未完成的核验，不会重新提交原任务。");
}

function validateThumbnails(thumbnails: AssetRankThumbnail[], report: AssetCandidateReport): void {
  if (thumbnails.length > MAX_RANK_THUMBNAILS) throw new Error("Saved ranking contains too many thumbnails.");
  const allowed = new Set(report.scenes.flatMap(scene => scene.candidates.map(candidate => evidenceKey({ ...candidate, scenePosition: scene.scenePosition }))));
  const seen = new Set<string>();
  for (const thumbnail of thumbnails) {
    const key = evidenceKey(thumbnail);
    const jpeg = Buffer.from(thumbnailJpegBase64(thumbnail.jpegBase64, "saved asset-rank jpegBase64"), "base64");
    if (!allowed.has(key) || seen.has(key) || createHash("sha256").update(jpeg).digest("hex") !== thumbnail.sha256) {
      throw new Error("Saved ranking thumbnail identity or digest does not match its candidate report.");
    }
    seen.add(key);
  }
}

function parseRankBatch(value: unknown, inputDigest: string, report: AssetCandidateReport): RankBatchState {
  const item = record(value, "saved ranking batch");
  if (item.version !== "asset-rank-batches-v1" || item.inputDigest !== inputDigest
    || !Number.isFinite(item.deadlineAt) || (item.phase !== "primary" && item.phase !== "supplement")) {
    throw new Error("Saved ranking batch does not match the current report or model; do not resubmit its pending operation.");
  }
  const payload = record(item.payload, "saved ranking payload");
  if (payload.version !== report.version || !Array.isArray(payload.scenes) || !Array.isArray(payload.thumbnails)) throw new Error("Saved ranking payload is invalid.");
  const positions = new Set<number>();
  for (const raw of payload.scenes) {
    const scene = record(raw, "saved ranking scene");
    const position = integer(scene.scenePosition, "saved ranking scene position", 1);
    const original = report.scenes.find(s => s.scenePosition === position);
    if (!original || positions.has(position) || digest(scene) !== digest(original)) throw new Error("Saved ranking scene changed from the current candidate report.");
    positions.add(position);
  }
  const parsed = item as unknown as RankBatchState;
  if (parsed.phase === "primary" && positions.size !== report.scenes.length) throw new Error("Saved primary ranking must preserve all scenes.");
  validateThumbnails(parsed.payload.thumbnails, parsed.payload);
  if (parsed.phase === "supplement") {
    if (!isRecord(item.primary) || !isRecord(item.primary.agentLoop) || item.primary.agentLoop.status !== "passed") throw new Error("Supplement requires a completed primary audit.");
    validateAssetSemanticRanking(parsed.primary!.output, report, { allowVisualEvidence: true });
    const primary = parsed.primary!.output;
    const reviewed = new Set(primary.visualEvidence?.reviewed.map(evidenceKey));
    for (const scene of parsed.payload.scenes) {
      if (primary.scenes.find(s => s.scenePosition === scene.scenePosition)?.candidates.some(c => c.locked || c.semanticScore >= 40)) {
        throw new Error("Supplement cannot overwrite an already usable scene.");
      }
    }
    if (parsed.payload.thumbnails.some(t => reviewed.has(evidenceKey(t)))) throw new Error("Supplement cannot reuse already reviewed evidence.");
  }
  if (parsed.finished) validateAssetSemanticRanking(parsed.finished.output, report, { allowVisualEvidence: true });
  return structuredClone(parsed);
}

function withVisualEvidence(execution: CodexTaskExecution<AssetSemanticRanking>, payload: RankPayload, report: AssetCandidateReport, supplementaryBatches: 0 | 1): AssetSemanticRanking {
  return { ...execution.output, visualEvidence: {
    reportDigest: reportDigest(report), supplementaryBatches,
    reviewed: execution.agentLoop?.status === "passed" ? payload.thumbnails.map(({ jpegBase64: _image, ...entry }) => entry) : [],
  } };
}

function mergeSupplement(primary: AssetSemanticRanking, supplement: AssetSemanticRanking, report: AssetCandidateReport): AssetSemanticRanking {
  const reviewed = new Set(supplement.visualEvidence!.reviewed.map(evidenceKey));
  const scenes = primary.scenes.map(scene => {
    const extra = supplement.scenes.find(item => item.scenePosition === scene.scenePosition);
    if (!extra) return scene;
    const candidates = scene.candidates.map(candidate => reviewed.has(evidenceKey({ ...candidate, scenePosition: scene.scenePosition }))
      ? extra.candidates.find(item => item.provider === candidate.provider && item.assetId === candidate.assetId)!
      : candidate);
    return { ...scene, summary: extra.summary, candidates: [...candidates]
      .sort((a, b) => b.semanticScore - a.semanticScore || a.originalRank - b.originalRank)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 })) };
  });
  return validateAssetSemanticRanking({ ...primary, scenes, visualEvidence: {
    reportDigest: reportDigest(report), supplementaryBatches: 1,
    reviewed: [...primary.visualEvidence!.reviewed, ...supplement.visualEvidence!.reviewed],
  } }, report, { allowVisualEvidence: true });
}

function combineAgentLoops(first: CodexTaskExecution["agentLoop"], last: CodexTaskExecution["agentLoop"]): CodexTaskExecution["agentLoop"] {
  if (!first || !last) return last ?? first;
  const result = { ...last, maxIterations: first.maxIterations + last.maxIterations,
    iterations: [...first.iterations, ...last.iterations].map((iteration, i) => ({ ...iteration, iteration: i + 1 })) };
  for (const key of ["modelCallCount", "producerModelCallCount", "auditModelCallCount", "structuredRepairModelCallCount", "producerMs", "auditMs", "validationMs", "retryCount"] as const) {
    result[key] = (first[key] ?? 0) + (last[key] ?? 0);
  }
  return result;
}

async function collectRankThumbnails(
  report: AssetCandidateReport,
  fetchThumbnail: (url: string) => Promise<Buffer | undefined>,
): Promise<AssetRankThumbnail[]> {
  const queue: Array<{ scenePosition: number; candidate: AssetCandidate }> = [];
  const maxCandidates = Math.max(0, ...report.scenes.map((scene) => scene.candidates.length));
  for (let candidateIndex = 0; candidateIndex < maxCandidates && queue.length < MAX_THUMBNAIL_ATTEMPTS; candidateIndex += 1) {
    for (const scene of report.scenes) {
      const candidate = scene.candidates[candidateIndex];
      if (candidate?.previewUrl && queue.length < MAX_THUMBNAIL_ATTEMPTS) queue.push({ scenePosition: scene.scenePosition, candidate });
    }
  }
  const thumbnails: AssetRankThumbnail[] = [];
  const deadline = Date.now() + THUMBNAIL_COLLECTION_MS;
  for (const item of queue) {
    if (thumbnails.length >= MAX_RANK_THUMBNAILS || Date.now() >= deadline) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const jpeg = await Promise.race([
        fetchThumbnail(item.candidate.previewUrl),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(5_000, deadline - Date.now())); }),
      ]);
      if (!jpeg || jpeg.length < 4 || jpeg.length > MAX_THUMBNAIL_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) continue;
      thumbnails.push({
        scenePosition: item.scenePosition,
        provider: item.candidate.provider,
        assetId: item.candidate.assetId,
        sha256: await sha256Hex(jpeg),
        jpegBase64: jpeg.toString("base64"),
      });
    } catch {
      // 单张缩略图失败只会降低该候选的视觉证据，不中断整次免费素材搜索。
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return thumbnails;
}

async function downloadCandidateThumbnail(rawUrl: string): Promise<Buffer | undefined> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || !THUMBNAIL_HOSTS.has(url.hostname) || url.username || url.password) return undefined;
  const response = await fetch(url, {
    headers: { accept: "image/jpeg" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "image/jpeg" || !response.body) return undefined;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_THUMBNAIL_BYTES) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_THUMBNAIL_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function sha256Hex(value: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

export function parseAssetCandidateReport(value: unknown): AssetCandidateReport {
  const report = record(value, "asset candidate report");
  if (report.version !== "video-factory/asset-candidates-v1") throw new Error("Asset candidate report version is invalid.");
  if (!Array.isArray(report.scene_candidates) || report.scene_candidates.length > 24) {
    throw new Error("Asset candidate scenes are invalid.");
  }
  const seenScenes = new Set<number>();
  const scenes = report.scene_candidates.map((item, sceneIndex): AssetCandidateScene => {
    const scene = record(item, `asset candidate scene ${sceneIndex}`);
    const scenePosition = integer(scene.scene_position, `asset candidate scene ${sceneIndex} position`, 1);
    if (seenScenes.has(scenePosition)) throw new Error(`Asset candidate scene ${scenePosition} is duplicated.`);
    seenScenes.add(scenePosition);
    if (!Array.isArray(scene.candidates) || scene.candidates.length > 24) {
      throw new Error(`Asset candidate scene ${scenePosition} candidates are invalid.`);
    }
    const candidates = scene.candidates.map((candidate, candidateIndex) => parseCandidate(candidate, scenePosition, candidateIndex));
    return {
      scenePosition,
      intent: stringRecord(scene.intent, `asset candidate scene ${scenePosition} intent`),
      query: text(scene.query, `asset candidate scene ${scenePosition} query`, true),
      candidates,
    };
  });
  return { version: "video-factory/asset-candidates-v1", scenes };
}

export function deterministicAssetRanking(
  report: AssetCandidateReport,
  fallbackReason = "语义排序能力暂不可用，保留素材源原始质量排序。",
): AssetSemanticRanking {
  const hasCandidates = report.scenes.some((scene) => scene.candidates.length > 0);
  return {
    version: "video-factory/asset-ranking-v1",
    source: "fallback",
    providerId: "deterministic-quality-v1",
    modelId: "quality-score-v1",
    summary: hasCandidates
      ? "候选素材仅按原始质量分和竖屏适配稳定排序；语义未验证，需恢复语义审查或由人工明确锁定后才能采用。"
      : "本次没有图库候选需要排序；后续由逐镜素材路由执行生成、复用或明确停住。",
    scenes: report.scenes.map((scene) => ({
      scenePosition: scene.scenePosition,
      summary: scene.candidates.length ? "当前排序语义未验证，不能自动采用。" : "该镜头没有可排序的图库候选。",
      candidates: scene.candidates
        .map((candidate, index) => ({ candidate, originalRank: index + 1 }))
        .sort((left, right) => right.candidate.qualityScore - left.candidate.qualityScore || left.originalRank - right.originalRank)
        .map(({ candidate, originalRank }, index) => ({
          provider: candidate.provider,
          assetId: candidate.assetId,
          originalRank,
          rank: index + 1,
          semanticScore: 0,
          rationale: "回退排序仅依据素材源质量分与原始顺序；未进行视觉语义判断。",
          locked: false,
        })),
    })),
    fallbackReason,
  };
}

export function validateAssetSemanticRanking(
  value: unknown,
  report: AssetCandidateReport,
  options: { allowLocks?: boolean; allowVisualEvidence?: boolean } = {},
): AssetSemanticRanking {
  const ranking = record(value, "asset semantic ranking");
  if (ranking.version !== "video-factory/asset-ranking-v1") throw new Error("Asset ranking version is invalid.");
  if (ranking.source !== "model" && ranking.source !== "fallback") throw new Error("Asset ranking source is invalid.");
  const providerId = text(ranking.providerId, "asset ranking providerId");
  const modelId = text(ranking.modelId, "asset ranking modelId");
  if (!Array.isArray(ranking.scenes) || ranking.scenes.length !== report.scenes.length) {
    throw new Error("Asset ranking must cover every candidate scene.");
  }
  const expectedScenes = new Map(report.scenes.map((scene) => [scene.scenePosition, scene]));
  const scenes = ranking.scenes.map((item, index): AssetRankingScene => {
    const scene = record(item, `asset ranking scene ${index}`);
    const scenePosition = integer(scene.scenePosition, `asset ranking scene ${index} position`, 1);
    const expected = expectedScenes.get(scenePosition);
    if (!expected) throw new Error(`Asset ranking contains unknown scene ${scenePosition}.`);
    expectedScenes.delete(scenePosition);
    if (!Array.isArray(scene.candidates) || scene.candidates.length !== expected.candidates.length) {
      throw new Error(`Asset ranking scene ${scenePosition} must cover every candidate.`);
    }
    const expectedKeys = new Set(expected.candidates.map(candidateKey));
    const originalRanks = new Map(expected.candidates.map((candidate, candidateIndex) => [candidateKey(candidate), candidateIndex + 1]));
    const seenKeys = new Set<string>();
    const seenRanks = new Set<number>();
    const candidates = scene.candidates.map((candidate, candidateIndex): AssetRankingCandidate => {
      const entry = record(candidate, `asset ranking scene ${scenePosition} candidate ${candidateIndex}`);
      const parsed = {
        provider: text(entry.provider, "asset ranking provider"),
        assetId: text(entry.assetId, "asset ranking assetId"),
        originalRank: integer(entry.originalRank, "asset ranking originalRank", 1, expected.candidates.length),
        rank: integer(entry.rank, "asset ranking rank", 1, expected.candidates.length),
        semanticScore: integer(entry.semanticScore, "asset ranking semanticScore", 0, 100),
        rationale: text(entry.rationale, "asset ranking rationale"),
        locked: booleanValue(entry.locked, "asset ranking locked"),
      };
      const key = `${parsed.provider}:${parsed.assetId}`;
      if (!expectedKeys.has(key) || seenKeys.has(key)) throw new Error(`Asset ranking candidate '${key}' is invalid or duplicated.`);
      if (parsed.originalRank !== originalRanks.get(key)) throw new Error(`Asset ranking candidate '${key}' has an invalid originalRank.`);
      if (parsed.locked && !options.allowLocks) throw new Error("Model-generated asset rankings cannot lock candidates.");
      if (seenRanks.has(parsed.rank)) throw new Error(`Asset ranking scene ${scenePosition} contains duplicate rank ${parsed.rank}.`);
      seenKeys.add(key);
      seenRanks.add(parsed.rank);
      return parsed;
    });
    return { scenePosition, summary: text(scene.summary, "asset ranking scene summary", true), candidates };
  });
  let visualEvidence: AssetSemanticRanking["visualEvidence"];
  if (options.allowVisualEvidence && ranking.visualEvidence !== undefined) {
    const evidence = record(ranking.visualEvidence, "asset ranking visualEvidence");
    if (evidence.reportDigest !== reportDigest(report) || (evidence.supplementaryBatches !== 0 && evidence.supplementaryBatches !== 1)
      || !Array.isArray(evidence.reviewed) || evidence.reviewed.length > 2 * MAX_RANK_THUMBNAILS) {
      throw new Error("Asset ranking visual evidence does not match its report or batch limit.");
    }
    const allowed = new Set(report.scenes.flatMap(scene => scene.candidates.map(candidate => evidenceKey({ ...candidate, scenePosition: scene.scenePosition }))));
    const seen = new Set<string>();
    const reviewed = evidence.reviewed.map(raw => {
      const item = record(raw, "asset ranking evidence entry");
      const entry = { scenePosition: integer(item.scenePosition, "evidence scenePosition", 1),
        provider: text(item.provider, "evidence provider"), assetId: text(item.assetId, "evidence assetId"), sha256: text(item.sha256, "evidence sha256") };
      const key = evidenceKey(entry);
      if (!allowed.has(key) || seen.has(key) || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Asset ranking evidence identity is invalid.");
      seen.add(key);
      return entry;
    });
    if (evidence.stopReason !== undefined && evidence.stopReason !== "deadline") throw new Error("Invalid ranking stop reason.");
    visualEvidence = { reportDigest: evidence.reportDigest, supplementaryBatches: evidence.supplementaryBatches, reviewed,
      ...(evidence.stopReason === "deadline" ? { stopReason: "deadline" as const } : {}),
    };
  }
  return {
    version: "video-factory/asset-ranking-v1",
    source: ranking.source,
    providerId,
    modelId,
    summary: text(ranking.summary, "asset ranking summary"),
    scenes,
    ...(ranking.fallbackReason === undefined ? {} : { fallbackReason: text(ranking.fallbackReason, "asset ranking fallbackReason") }),
    ...(visualEvidence ? { visualEvidence } : {}),
  };
}

function parseCandidate(value: unknown, scenePosition: number, index: number): AssetCandidate {
  const candidate = record(value, `asset candidate scene ${scenePosition} item ${index}`);
  const mediaType = candidate.media_type;
  if (mediaType !== "image" && mediaType !== "video") throw new Error("Asset candidate media type is invalid.");
  return {
    provider: text(candidate.provider, "asset candidate provider"),
    ...(candidate.provider_id === undefined || candidate.provider_id === null ? {} : { providerId: text(candidate.provider_id, "asset candidate providerId") }),
    assetId: text(candidate.asset_id, "asset candidate assetId"),
    mediaType,
    width: integer(candidate.width, "asset candidate width", 0),
    height: integer(candidate.height, "asset candidate height", 0),
    duration: finite(candidate.duration, "asset candidate duration", 0),
    previewUrl: text(candidate.preview_url, "asset candidate previewUrl", true),
    sourceUrl: text(candidate.source_url, "asset candidate sourceUrl", true),
    creator: text(candidate.creator, "asset candidate creator", true),
    licenseNote: text(candidate.license_note, "asset candidate licenseNote", true),
    query: text(candidate.query, "asset candidate query", true),
    qualityScore: finite(candidate.score, "asset candidate score"),
  };
}

function candidateKey(candidate: AssetCandidate): string {
  return `${candidate.provider}:${candidate.assetId}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (value === undefined) return {};
  return Object.fromEntries(Object.entries(record(value, label)).map(([key, item]) => [key, text(item, `${label}.${key}`, true)]));
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 2_000) throw new Error(`${label} is invalid.`);
  return value.trim();
}

/**
 * 缩略图 base64 的读取校验，与 collectRankThumbnails 的写入校验对称：同一个长度上界，
 * 同样核对 JPEG 魔数。写入侧只接受 0xff 0xd8 开头的图，读取侧就不能接受别的。
 */
function thumbnailJpegBase64(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_THUMBNAIL_BASE64_CHARS) {
    throw new Error(`${label} is invalid.`);
  }
  const jpeg = Buffer.from(value, "base64");
  if (jpeg.length < 4 || jpeg.length > MAX_THUMBNAIL_BYTES || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`${label} is invalid.`);
  return Number(value);
}

function finite(value: unknown, label: string, minimum = -Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) throw new Error(`${label} is invalid.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is invalid.`);
  return value;
}
