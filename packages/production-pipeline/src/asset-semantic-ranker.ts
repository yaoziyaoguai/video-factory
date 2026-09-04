import type { CodexBridgeClient, CodexTaskExecution } from "./codex-chat.js";
import { runRoleAgentLoop, type RoleAgentLoopCheckpoint } from "./role-agent-loop.js";

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
}

export interface AssetSemanticRanker {
  readonly id: string;
  readonly modelId: string;
  rank(report: AssetCandidateReport): Promise<AssetSemanticRanking>;
  rankDetailed?(report: AssetCandidateReport, checkpoint?: RoleAgentLoopCheckpoint): Promise<CodexTaskExecution<AssetSemanticRanking>>;
}

export interface CodexAssetSemanticRankerOptions {
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed">>;
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
const MAX_THUMBNAIL_BYTES = 512 * 1024;
const THUMBNAIL_HOSTS = new Set(["images.pexels.com", "cdn.pixabay.com"]);
export const ASSET_RANK_AGENT_CONTRACT_VERSION = "asset-rank-v2|role-audit-v1|asset-ranking-validator-v1";

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

  async rankDetailed(report: AssetCandidateReport, checkpoint?: RoleAgentLoopCheckpoint): Promise<CodexTaskExecution<AssetSemanticRanking>> {
    const client = this.options.client;
    if (typeof client.runTaskDetailed !== "function") return { output: await this.rank(report) };
    const payload = await this.rankPayload(report);
    return runRoleAgentLoop({
      role: "候选画面复核",
      contractVersion: ASSET_RANK_AGENT_CONTRACT_VERSION,
      criteria: [
        "逐镜候选完整保留，排名和原始排名均连续且没有重复",
        "排序理由引用可见证据或明确承认证据不足，不根据 URL、作者或素材 ID 臆测",
        "主体、环境、动作、景别、构图与连续性优先于单纯分辨率和素材源质量分",
        "首选候选的核心主体、物体和动作必须与该镜导演意图一致；环境相似或动作相关不能替代核心对象匹配，没有合格候选时不得通过审计",
        "没有把候选锁定，也没有新增、删除或替换候选素材",
      ],
      maxIterations: this.options.maxReviewIterations ?? 3,
      produce: (revision, { requestId, session }) => client.runTaskDetailed!("asset-rank", {
        ...payload,
        ...(revision ? { revision } : {}),
      }, requestId, session),
      audit: ({ role, iteration, criteria, candidate, previousAudit, requestId, session }) => client.runTaskDetailed!("role-audit", {
        role,
        iteration,
        criteria,
        context: {
          roleScope: {
            owns: ["候选排序", "semanticScore", "rationale"],
            doesNotOwn: ["新增候选", "删除候选", "下载素材", "锁定人工选择"],
          },
          upstreamFacts: { version: report.version, scenes: report.scenes },
          currentRoleContract: { preserveEveryCandidate: true, ranksStartAtOneAndAreUnique: true, lockedMustRemainFalse: true },
          downstreamBoundary: "只排序已有候选；不得要求尚未下载的原文件或后续成片作为当前节点通过证据。",
        },
        candidate,
        ...(previousAudit ? { previousAudit } : {}),
        images: payload.thumbnails.map((thumbnail, index) => ({
          imageIndex: index + 1,
          scenePosition: thumbnail.scenePosition,
          provider: thumbnail.provider,
          assetId: thumbnail.assetId,
          sha256: thumbnail.sha256,
          jpegBase64: thumbnail.jpegBase64,
        })),
      }, requestId, session),
      validate: (value) => validateAssetSemanticRanking(value, report),
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  private async rankPayload(report: AssetCandidateReport): Promise<AssetCandidateReport & { thumbnails: AssetRankThumbnail[] }> {
    return {
      ...report,
      thumbnails: await collectRankThumbnails(report, this.options.fetchThumbnail ?? downloadCandidateThumbnail),
    };
  }
}

async function collectRankThumbnails(
  report: AssetCandidateReport,
  fetchThumbnail: (url: string) => Promise<Buffer | undefined>,
): Promise<AssetRankThumbnail[]> {
  const queue: Array<{ scenePosition: number; candidate: AssetCandidate }> = [];
  const maxCandidates = Math.max(0, ...report.scenes.map((scene) => scene.candidates.length));
  for (let candidateIndex = 0; candidateIndex < maxCandidates && queue.length < MAX_RANK_THUMBNAILS; candidateIndex += 1) {
    for (const scene of report.scenes) {
      const candidate = scene.candidates[candidateIndex];
      if (candidate?.previewUrl && queue.length < MAX_RANK_THUMBNAILS) queue.push({ scenePosition: scene.scenePosition, candidate });
    }
  }
  const thumbnails: AssetRankThumbnail[] = [];
  for (const item of queue) {
    try {
      const jpeg = await fetchThumbnail(item.candidate.previewUrl);
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
  return {
    version: "video-factory/asset-ranking-v1",
    source: "fallback",
    providerId: "deterministic-quality-v1",
    modelId: "quality-score-v1",
    summary: "候选素材按原始质量分和竖屏适配稳定排序；可在执行下载前人工调整。",
    scenes: report.scenes.map((scene) => ({
      scenePosition: scene.scenePosition,
      summary: scene.candidates.length ? "当前排序未进行视觉语义判断。" : "该镜头没有可排序的图库候选。",
      candidates: scene.candidates
        .map((candidate, index) => ({ candidate, originalRank: index + 1 }))
        .sort((left, right) => right.candidate.qualityScore - left.candidate.qualityScore || left.originalRank - right.originalRank)
        .map(({ candidate, originalRank }, index) => ({
          provider: candidate.provider,
          assetId: candidate.assetId,
          originalRank,
          rank: index + 1,
          semanticScore: Math.max(1, 70 - index * 5),
          rationale: "回退排序：依据素材源质量分、方向与原始顺序。",
          locked: false,
        })),
    })),
    fallbackReason,
  };
}

export function validateAssetSemanticRanking(
  value: unknown,
  report: AssetCandidateReport,
  options: { allowLocks?: boolean } = {},
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
  return {
    version: "video-factory/asset-ranking-v1",
    source: ranking.source,
    providerId,
    modelId,
    summary: text(ranking.summary, "asset ranking summary"),
    scenes,
    ...(ranking.fallbackReason === undefined ? {} : { fallbackReason: text(ranking.fallbackReason, "asset ranking fallbackReason") }),
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
