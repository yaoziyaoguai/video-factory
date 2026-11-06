import { createWriteStream } from "node:fs";
import { mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  MaterialBatch, MaterialBatchIndexItem, MaterialCandidate, MaterialImportResult, MaterialProvider, MaterialQuery, MediaContent, MediaProvenance, ToolImportMaterial,
} from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { AgentError, AgentToolError } from "./errors.js";
import { probeAudioFile, probeImageFile, probeVideoFile } from "./media-probe.js";
import type { StockClient, StockCandidateInput, StockImportDetails } from "./stock-providers.js";
import { StockUnavailableError } from "./stock-http.js";
import { canonicalJson, newAgentId, type AgentClock } from "./util.js";

// 素材候选与采用事实：候选按同用户/会话跨轮读取，request 只记录产生来源；
// 每次搜索保存一个批次（含空结果与原顺序）。import 把选中 variant 下载为私有 blob 并同事务登记来源。

export const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export interface MaterialScope {
  ownerId: string;
  conversationId: string;
  requestId: string;
}

/** import 写入前复核的请求事实：下载是异步的，落库时请求可能已被停止或交付关闭。 */
export interface RequestStillActive {
  executionEpoch: number;
}

interface CandidateRow {
  id: string;
  owner_id: string;
  conversation_id: string;
  request_id: string;
  provider_asset_id: string;
  kind: MaterialCandidate["kind"];
  download_url: string;
  metadata_json: string;
  imported_blob_id: string | null;
  created_at: string;
}

interface CandidateMetadata extends Pick<MediaProvenance, "title" | "licenseName" | "attributionText" | "usageScope" | "licenseVersion"> {
  /** 旧记录没有 provider 与 trackingUrl 字段；provider 缺失时按 Pexels 解释，不回写。 */
  provider?: MaterialProvider;
  providerAssetId: string;
  sourceUrl: string;
  creatorName: string | null;
  creatorUrl: string | null;
  licenseUrl: string;
  /** Unsplash 的 download_location 采用追踪；只在采用时使用一次。 */
  trackingUrl?: string;
  /** 首次采用同次 probe 的实际像素；旧记录缺失时不补测。 */
  dimensions?: MaterialImportResult["dimensions"];
  vocalKind?: MaterialCandidate["vocalKind"];
  lyricsLanguage?: MaterialCandidate["lyricsLanguage"];
  sourceFacts?: StockImportDetails["sourceFacts"];
  usage?: ToolImportMaterial["usage"];
  /** 每个候选自己的首次采用事实；同 blob 后来的来源不能覆盖它。 */
  adoptedSource?: MediaProvenance;
}

export function persistSearchBatch(
  db: AgentDatabase, clock: AgentClock, scope: MaterialScope,
  input: { query: MaterialQuery; toolCallId: string; workId: string | null }, results: StockCandidateInput[],
): { batch: MaterialBatch; results: MaterialCandidate[] } {
  const now = clock();
  const batchId = newAgentId("batch");
  const write = db.transaction(() => {
    const candidates: MaterialCandidate[] = [];
    for (const item of results) {
      const metadata: CandidateMetadata = {
        provider: item.candidate.provider,
        providerAssetId: item.candidate.providerAssetId,
        sourceUrl: item.candidate.sourceUrl,
        creatorName: item.candidate.creatorName,
        creatorUrl: item.candidate.creatorUrl,
        licenseUrl: item.candidate.licenseUrl,
        ...(item.candidate.kind === "audio" ? {
          title: item.candidate.title, licenseName: item.candidate.licenseName,
          attributionText: item.candidate.attributionText, usageScope: item.candidate.usageScope,
          licenseVersion: item.candidate.licenseVersion, vocalKind: item.candidate.vocalKind,
          lyricsLanguage: item.candidate.lyricsLanguage,
        } : {}),
        ...(item.trackingUrl ? { trackingUrl: item.trackingUrl } : {}),
      };
      db.prepare(`INSERT INTO material_candidates(id,owner_id,conversation_id,request_id,provider_asset_id,kind,download_url,metadata_json,batch_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(item.candidateId, scope.ownerId, scope.conversationId, scope.requestId,
          metadata.providerAssetId, item.candidate.kind, item.downloadUrl, JSON.stringify(metadata), batchId, now);
      candidates.push(item.candidate);
    }
    db.prepare(`INSERT INTO material_search_batches(id,owner_id,conversation_id,request_id,tool_call_id,work_id,query_json,results_json,retrieved_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(batchId, scope.ownerId, scope.conversationId, scope.requestId, input.toolCallId, input.workId,
        canonicalJson(input.query), canonicalJson(candidates), now, now);
    return candidates;
  });
  const candidates = write();
  return {
    batch: {
      batchId, revision: 1, requestId: scope.requestId, toolCallId: input.toolCallId, ...(input.workId ? { workId: input.workId } : {}),
      query: input.query, retrievedAt: now, results: candidates, messageId: null,
    },
    results: candidates,
  };
}

/** 早期批次查询没有 provider 字段；当时只有 Pexels，读取时补默认来源。 */
function parseStoredQuery(raw: string): MaterialQuery {
  const query = JSON.parse(raw) as MaterialQuery;
  return { ...query, provider: query.provider ?? "pexels" };
}

export function readMaterialBatch(db: AgentDatabase, ownerId: string, batchId: string): MaterialBatch | null {
  const row = db.prepare("SELECT * FROM material_search_batches WHERE id=? AND owner_id=?").get(batchId, ownerId) as {
    id: string; request_id: string; tool_call_id: string; work_id: string | null; query_json: string; results_json: string;
    retrieved_at: string; message_id: string | null;
  } | undefined;
  if (!row) return null;
  const query = parseStoredQuery(row.query_json);
  const results = (JSON.parse(row.results_json) as MaterialCandidate[]).map(candidate => {
    const provider = candidate.provider ?? query.provider;
    const result = { ...candidate, provider };
    if (candidate.dimensionsKind || candidate.width === null || candidate.height === null) return result;
    // 旧批次只按当时适配器可证明的尺寸来源标注，不回写，也不将原作冒充下载变体。
    if (provider === "unsplash" || provider === "coverr" || (provider === "pixabay" && candidate.kind === "image")) {
      return { ...result, dimensionsKind: "source" as const };
    }
    if (provider === "pexels" || provider === "pixabay" || provider === "wikimedia" || provider === "cleveland" || provider === "archive") {
      return { ...result, dimensionsKind: "download" as const };
    }
    return result;
  });
  return {
    batchId: row.id, revision: 1, requestId: row.request_id, toolCallId: row.tool_call_id, ...(row.work_id ? { workId: row.work_id } : {}),
    query, retrievedAt: row.retrieved_at, results, messageId: row.message_id,
  };
}

export function listMaterialBatches(db: AgentDatabase, conversationId: string, limit: number): MaterialBatchIndexItem[] {
  return (db.prepare(
    "SELECT id, request_id, message_id, query_json, results_json, retrieved_at FROM material_search_batches WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(conversationId, limit) as {
    id: string; request_id: string; message_id: string | null; query_json: string; results_json: string; retrieved_at: string;
  }[]).map(row => ({
    batchId: row.id, requestId: row.request_id, messageId: row.message_id,
    query: parseStoredQuery(row.query_json), retrievedAt: row.retrieved_at,
    resultCount: (JSON.parse(row.results_json) as MaterialCandidate[]).length,
  }));
}

function getCandidate(db: AgentDatabase, scope: Pick<MaterialScope, "ownerId" | "conversationId">, candidateId: string): CandidateRow | undefined {
  return db.prepare("SELECT * FROM material_candidates WHERE id=? AND owner_id=? AND conversation_id=?")
    .get(candidateId, scope.ownerId, scope.conversationId) as CandidateRow | undefined;
}

function provenanceOf(metadata: CandidateMetadata, acquiredAt: string): MediaProvenance {
  return {
    provider: metadata.provider ?? "pexels", assetId: metadata.providerAssetId, sourceUrl: metadata.sourceUrl,
    creatorName: metadata.creatorName, creatorUrl: metadata.creatorUrl, licenseUrl: metadata.licenseUrl, acquiredAt,
    ...(metadata.title !== undefined ? { title: metadata.title } : {}),
    ...(metadata.licenseName !== undefined ? { licenseName: metadata.licenseName } : {}),
    ...(metadata.attributionText !== undefined ? { attributionText: metadata.attributionText } : {}),
    ...(metadata.usageScope !== undefined ? { usageScope: metadata.usageScope } : {}),
    ...(metadata.licenseVersion !== undefined ? { licenseVersion: metadata.licenseVersion } : {}),
  };
}

function importResultOf(
  db: AgentDatabase, blobId: string, provenance: MediaProvenance, dimensions?: MaterialImportResult["dimensions"],
): MaterialImportResult {
  const blob = db.prepare("SELECT digest, mime_type, duration_ms FROM production_blobs WHERE id=?").get(blobId) as
    { digest: string; mime_type: MediaContent["mimeType"]; duration_ms: number | null };
  return { blobId, digest: blob.digest, mimeType: blob.mime_type, durationMs: blob.duration_ms, provenance, ...(dimensions ? { dimensions } : {}) };
}

/** 下载选中 variant、探测真实文件、写入 blob 并同事务登记采用与来源；重放复用已存 blob。 */
export async function importMaterial(
  db: AgentDatabase, clock: AgentClock, blobs: ProductionBlobs, workRoot: string,
  client: StockClient, scope: MaterialScope, active: RequestStillActive, candidateId: string, signal?: AbortSignal, usage?: ToolImportMaterial["usage"],
): Promise<MaterialImportResult> {
  const row = getCandidate(db, scope, candidateId);
  if (!row) throw new AgentError("NOT_FOUND", "没有找到这个会话里的素材候选。");
  const metadata = JSON.parse(row.metadata_json) as CandidateMetadata;
  const provider = metadata.provider ?? "pexels";
  if (provider === "freetouse" && usage !== "personal_social_ugc") {
    throw new AgentToolError("INVALID_INPUT", usage === "other"
      ? "FreeToUse Non-Premium 免费许可不适用于品牌、商业宣传或赞助等用途，不能采用；系统不会自动购买许可。"
      : "FreeToUse 免费音乐采用需要明确个人社交平台自制内容 UGC 用途（可含平台变现），请先确认本次用途。");
  }
  // 新采用逐候选保存事实；旧视觉记录仍按原 provider+assetId 找回已有来源，不回填历史。
  const adoptedSource = (blobId: string, adoptedMetadata = metadata): MediaProvenance => {
    const source = adoptedMetadata.adoptedSource
      ?? blobSources(db, blobId).find(item => item.provider === provider && item.assetId === row.provider_asset_id);
    if (!source) throw new AgentError("NOT_FOUND", "没有找到这个素材的采用来源。");
    return source;
  };
  if (row.imported_blob_id) {
    return importResultOf(db, row.imported_blob_id, adoptedSource(row.imported_blob_id), metadata.dimensions);
  }
  // 能力以候选行记录的来源为准：搜索时可用不代表采用时仍然启用。
  if (!client.ready(provider)) {
    throw new AgentToolError("CAPABILITY_UNAVAILABLE", `${client.labelOf(provider)} 素材服务未启用，不能采用素材。`);
  }

  const maxBytes = row.kind === "image" ? MAX_IMAGE_BYTES : row.kind === "audio" ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES;
  const attemptDir = path.join(workRoot, candidateId);
  const temporary = path.join(attemptDir, "download.part");
  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  try {
    const detail = await client.prepareImport(provider, { providerAssetId: row.provider_asset_id, trackingUrl: metadata.trackingUrl }, signal);
    if (detail) {
      const source = detail.candidate;
      Object.assign(metadata, {
        title: source.title, creatorName: source.creatorName, creatorUrl: source.creatorUrl,
        sourceUrl: source.sourceUrl, licenseUrl: source.licenseUrl, licenseName: source.licenseName,
        attributionText: source.attributionText, usageScope: source.usageScope, licenseVersion: source.licenseVersion,
        vocalKind: source.vocalKind, lyricsLanguage: source.lyricsLanguage, sourceFacts: detail.sourceFacts, usage,
      });
    }
    await client.download(provider, detail?.downloadUrl ?? row.download_url, maxBytes, async stream => {
      await pipeline(Readable.fromWeb(stream as import("node:stream/web").ReadableStream), createWriteStream(temporary, { mode: 0o600 }), { signal });
    }, signal);
    const facts = row.kind === "image" ? await probeImageFile(temporary, signal)
      : row.kind === "audio" ? await probeAudioFile(temporary, signal) : await probeVideoFile(temporary, "ffprobe", signal);
    const bytes = await readFile(temporary, { signal });
    signal?.throwIfAborted();
    const blob = blobs.persist(scope.ownerId, scope.conversationId, bytes, facts.mimeType, "durationMs" in facts ? facts.durationMs : null);
    const write = db.transaction((): MaterialImportResult => {
      // 异步下载后的事实复核：请求仍在运行、同 epoch、未交付关闭，才登记采用关系。
      const request = db.prepare("SELECT state, execution_epoch, delivery_closed, stop_requested FROM requests WHERE id=?")
        .get(scope.requestId) as { state: string; execution_epoch: number; delivery_closed: number; stop_requested: number };
      if (!request || request.state !== "running" || request.execution_epoch !== active.executionEpoch
        || request.delivery_closed === 1 || request.stop_requested === 1) {
        throw new AgentError("REQUEST_NOT_RUNNING", "请求已结束或被停止，本次采用不再登记。");
      }
      const current = getCandidate(db, scope, candidateId);
      if (current?.imported_blob_id) {
        const adoptedMetadata = JSON.parse(current.metadata_json) as CandidateMetadata;
        return importResultOf(db, current.imported_blob_id, adoptedSource(current.imported_blob_id, adoptedMetadata), adoptedMetadata.dimensions);
      }
      const acquiredAt = clock();
      const dimensions = "width" in facts ? { width: facts.width, height: facts.height } : undefined;
      const provenance = provenanceOf(metadata, acquiredAt);
      recordBlobSources(db, blob.id, [provenance]);
      db.prepare("UPDATE material_candidates SET imported_blob_id=?, metadata_json=?, download_url=? WHERE id=?")
        .run(blob.id, JSON.stringify({ ...metadata, ...(dimensions ? { dimensions } : {}), adoptedSource: provenance }), detail?.downloadUrl ?? row.download_url, candidateId);
      return importResultOf(db, blob.id, provenance, dimensions);
    });
    return write();
  } catch (error) {
    if (error instanceof StockUnavailableError) throw new AgentError("TEMPORARILY_UNAVAILABLE", error.message);
    throw error;
  } finally {
    rmSync(attemptDir, { recursive: true, force: true });
  }
}

/** prepare 核对准确音频候选与输入 blob 后冻结来源；不按同 blob 的其它候选/最新来源推断。 */
export function readAdoptedAudioSource(
  db: AgentDatabase, scope: Pick<MaterialScope, "ownerId" | "conversationId">, candidateId: string, blobId: string,
): MediaProvenance {
  const candidate = getCandidate(db, scope, candidateId);
  if (!candidate) throw new AgentError("NOT_FOUND", "没有找到这个会话里的音乐候选。");
  if (candidate.kind !== "audio" || candidate.imported_blob_id !== blobId) {
    throw new AgentError("TARGET_SCOPE_MISMATCH", "音乐必须引用本会话中该音频候选已采用的准确媒体对象。");
  }
  const metadata = JSON.parse(candidate.metadata_json) as CandidateMetadata;
  if (!metadata.adoptedSource) throw new AgentError("NOT_FOUND", "没有找到这个音乐候选首次采用的来源事实。");
  return metadata.adoptedSource;
}

/** 交付时把受控 media_reference 解析为真实 MediaContent；blob 必须来自同会话已完成采用且 kind 一致。 */
export function resolveMediaReference(
  db: AgentDatabase, scope: Pick<MaterialScope, "ownerId" | "conversationId">, blobId: string, kind: MaterialCandidate["kind"],
): MediaContent | null {
  const candidate = db.prepare(
    "SELECT kind FROM material_candidates WHERE imported_blob_id=? AND owner_id=? AND conversation_id=?",
  ).get(blobId, scope.ownerId, scope.conversationId) as { kind: MaterialCandidate["kind"] } | undefined;
  if (!candidate || candidate.kind !== kind) return null;
  return mediaContentOfBlob(db, blobId);
}

export function mediaContentOfBlob(db: AgentDatabase, blobId: string): MediaContent | null {
  const blob = db.prepare("SELECT id, mime_type, duration_ms FROM production_blobs WHERE id=?").get(blobId) as
    { id: string; mime_type: MediaContent["mimeType"]; duration_ms: number | null } | undefined;
  if (!blob) return null;
  const sources = blobSources(db, blobId);
  return { format: "media", blobId: blob.id, mimeType: blob.mime_type, durationMs: blob.duration_ms, ...(sources.length > 0 ? { sources } : {}) };
}

export function blobSources(db: AgentDatabase, blobId: string): MediaProvenance[] {
  const row = db.prepare("SELECT sources_json FROM material_blob_sources WHERE blob_id=?").get(blobId) as { sources_json: string } | undefined;
  return row ? JSON.parse(row.sources_json) as MediaProvenance[] : [];
}

/** 采用、提案与发布共用同一来源合并规则；64 是现行 MediaContent 合同上限，不能截掉署名。 */
export function mergeSources(groups: readonly (readonly MediaProvenance[])[]): MediaProvenance[] {
  const seen = new Set<string>();
  const aggregated: MediaProvenance[] = [];
  for (const sources of groups) {
    for (const source of sources) {
      const key = `${source.provider}:${source.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      aggregated.push(source);
    }
  }
  if (aggregated.length > 64) throw new AgentError("INVALID_INPUT", "合并后的素材来源超过 64 项，请减少本次使用的素材。");
  return aggregated;
}

/** render 发布成品时按输入顺序聚合来源；按(provider,assetId)去重并保持首次使用顺序。 */
export function aggregateSources(db: AgentDatabase, blobIds: readonly string[]): MediaProvenance[] {
  return mergeSources(blobIds.map(blobId => blobSources(db, blobId)));
}

/** 采用与合成共享的来源登记；同一内容可被再次采用，保留首次来源顺序与时间。 */
export function recordBlobSources(db: AgentDatabase, blobId: string, incoming: readonly MediaProvenance[]): MediaProvenance[] {
  const sources = mergeSources([blobSources(db, blobId), incoming]);
  if (sources.length) db.prepare(`INSERT INTO material_blob_sources(blob_id,sources_json) VALUES(?,?)
    ON CONFLICT(blob_id) DO UPDATE SET sources_json=excluded.sources_json`).run(blobId, JSON.stringify(sources));
  return sources;
}
