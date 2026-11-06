import { closeSync, createWriteStream, fsyncSync, mkdirSync, openSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ExecutionObservation, OperationSpec } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { recordAttemptOutput, runRow } from "./production-store.js";
import { InvalidVideoFile, probeVideoFile, type VideoFileFacts } from "./media-probe.js";
import { digestOf, type AgentClock } from "./util.js";

// 供应商媒体端口共用的一次性收尾件：受控 HTTP、确定性下载与观测/收据工厂。
// 各端口自带协议 wire 与冻结参数校验；这里不做供应商分支，也不引入端口基类。

export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface ProviderHttpOptions {
  fetchImpl?: typeof fetch | undefined;
  requestTimeoutMs?: number | undefined;
}

/** 受控 JSON 请求：非 2xx 抛 ProviderHttpError（只含状态，不含供应商正文/凭据）；非对象响应抛错。 */
export async function providerRequestJson(method: "POST" | "GET", url: URL, apiKey: string, body: unknown,
  options: ProviderHttpOptions & { headers?: Record<string, string>; signal?: AbortSignal | undefined } = {}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs ?? 30_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers ?? {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应按状态处理 */ }
    if (!response.ok) throw new ProviderHttpError(`HTTP ${response.status}`, response.status);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("供应商响应不是对象。");
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

export class NonCompliantOutput extends Error {}

export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

/** 确定性下载：先写 .part 再原子改名；带超时与字节上限，超限判非合规（完整事实，不是网络失败）。 */
export async function downloadToFile(fetchImpl: typeof fetch, url: URL, attemptDir: string, finalFile: string,
  options: { downloadTimeoutMs?: number | undefined; maxDownloadBytes?: number | undefined } = {}): Promise<void> {
  mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(attemptDir, "download.part");
  const controller = new AbortController();
  const limit = options.maxDownloadBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
  let received = 0;
  const timer = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "manual" });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? Number.NaN);
    if (Number.isSafeInteger(declared) && declared > limit) {
      throw new NonCompliantOutput(`文件超过大小上限（${declared} 字节）`);
    }
    const capped = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    capped.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > limit) controller.abort();
    });
    await pipeline(capped, createWriteStream(temporary, { mode: 0o600 }));
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, finalFile);
  } catch (error) {
    if (received > limit) throw new NonCompliantOutput("文件超过下载大小上限。");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function validateHttpUrl(value: unknown): URL {
  const url = typeof value === "string" ? new URL(value) : null;
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("供应商返回的下载地址不是合法的 HTTP(S) URL");
  }
  return url;
}

/**
 * 观测与收据工厂：同一 attempt 的确定性观测使用稳定 observationId 与提交时间，
 * stable/unstable unknown 的区别只在是否允许产生新事实。nonCompliant 落 failed 收据。
 */
export class PortObservations {
  constructor(private readonly db: AgentDatabase, private readonly clock: AgentClock, readonly scopeKey: string) {}

  now(): string { return this.clock(); }

  deterministic(attemptId: string, state: "failed" | "cancelled", providerTaskId: string | null, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: this.scopeKey, state, message }).slice(0, 24)}`,
      attemptId, state, providerTaskId, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  deterministicSucceeded(attemptId: string, providerTaskId: string | null, blobId: string, digest: string,
    mimeType: "video/mp4" | "audio/mpeg" = "video/mp4",
    message = mimeType === "audio/mpeg" ? "供应商音频已解码并核对通过。" : "供应商视频已下载并核对通过。"): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: this.scopeKey, state: "succeeded", blobId }).slice(0, 24)}`,
      attemptId, state: "succeeded", providerTaskId, blob: { id: blobId, digest, mimeType },
      observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  // 稳定未知：同一 attempt 每次查询得到同一条观测，不生成新事实。
  stableUnknown(attemptId: string, message: string, providerTaskId: string | null = null): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: `${this.scopeKey}-unknown`, message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  unstableUnknown(attemptId: string, providerTaskId: string | null, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: `${this.scopeKey}-transient`, at: this.clock(), message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId, blob: null, observedAt: this.clock(), message, billing: null,
    };
  }

  // 完整文件已取得且确定不合规：failed 终态、保留 task ID 与原因、费用独立待核，不再获取同一无效文件。
  nonCompliant(attemptId: string, providerTaskId: string | null, reason: string): ExecutionObservation {
    const message = `已完整取得的输出不满足冻结参数：${reason}`;
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId,
      { ...(providerTaskId ? { providerTaskId } : {}), exitKind: "failed", detail: message }))();
    return this.deterministic(attemptId, "failed", providerTaskId, message);
  }

  stableTime(attemptId: string): string {
    const row = this.db.prepare("SELECT r.created_at AS at FROM production_runs r JOIN production_attempts a ON a.run_id=r.id WHERE a.id=?")
      .get(attemptId) as { at: string } | undefined;
    return row?.at ?? this.clock();
  }
}

export interface SettleVideoParams {
  db: AgentDatabase;
  blobs: ProductionBlobs;
  observations: PortObservations;
  attemptId: string;
  runId: string;
  operationId: string;
  providerTaskId: string | null;
  /** 确定性成品位置；与 attemptDir 配合恢复已下载文件。 */
  attemptDir: string;
  finalFile: string;
  /** 供应商刚返回的下载地址；恢复已有文件时不传。 */
  download?: { url: URL; fetchImpl: typeof fetch; downloadTimeoutMs?: number | undefined; maxDownloadBytes?: number | undefined };
  /** 冻结参数校验：返回不合规原因（完整文件已取得，判 failed），null 表示通过。 */
  validate: (facts: VideoFileFacts, op: Extract<OperationSpec, { kind: "video" }>) => string | null;
  /** 下载/探测暂时失败时保留任务与文件的 running 文案。 */
  retryMessage: string;
}

/** 供应商视频成片的共同收尾：下载到确定性位置、probe、按冻结参数校验、发布 blob 并记录收据。 */
export async function settleDownloadedVideo(params: SettleVideoParams): Promise<ExecutionObservation> {
  const { db, blobs, observations } = params;
  try {
    if (params.download) {
      await downloadToFile(params.download.fetchImpl, params.download.url, params.attemptDir, params.finalFile, params.download);
    }
    const facts = await probeVideoFile(params.finalFile);
    const row = db.prepare("SELECT spec_json FROM production_operations WHERE run_id=? AND id=?")
      .get(params.runId, params.operationId) as { spec_json: string };
    const op = JSON.parse(row.spec_json) as Extract<OperationSpec, { kind: "video" }>;
    const reason = params.validate(facts, op);
    if (reason) return observations.nonCompliant(params.attemptId, params.providerTaskId, reason);
    const run = runRow(db, params.runId);
    const blob = blobs.persist(run.owner_id, run.conversation_id, readFileSync(params.finalFile), "video/mp4", facts.durationMs);
    db.transaction(() => recordAttemptOutput(db, observations.now(), params.attemptId,
      { ...(params.providerTaskId ? { providerTaskId: params.providerTaskId } : {}), blobId: blob.id, digest: blob.digest }))();
    return observations.deterministicSucceeded(params.attemptId, params.providerTaskId, blob.id, blob.digest);
  } catch (error) {
    if (error instanceof InvalidVideoFile || error instanceof NonCompliantOutput) {
      return observations.nonCompliant(params.attemptId, params.providerTaskId, error.message);
    }
    // 网络或探测工具暂不可用：保留任务与完整文件；已有文件不会重新下载。
    return {
      observationId: `obs-${digestOf({ attemptId: params.attemptId, scope: `${observations.scopeKey}-download-retry`, at: observations.now() }).slice(0, 24)}`,
      attemptId: params.attemptId, state: "running", providerTaskId: params.providerTaskId, blob: null,
      observedAt: observations.now(),
      message: params.retryMessage,
      billing: null,
    };
  }
}

/** 时长容差：帧周期内视为与冻结秒数一致。 */
export function durationMismatch(facts: VideoFileFacts, expectedSeconds: number): string | null {
  const expectedMs = expectedSeconds * 1000;
  const frameMs = Math.ceil(1000 / (facts.frameRate ?? 24));
  return Math.abs(facts.videoDurationMs - expectedMs) > frameMs
    ? `输出时长 ${facts.videoDurationMs} ms 与冻结秒数 ${expectedMs} ms 不符（容差 ${frameMs} ms）` : null;
}

/** 冻结画幅：允许宽高各取整一像素造成的误差，不把明确的 1:1 当作 16:9。 */
export function aspectRatioMismatch(facts: VideoFileFacts, aspectRatio: Extract<OperationSpec, { kind: "video" }>["parameters"]["aspectRatio"]): string | null {
  const [widthRatio, heightRatio] = aspectRatio.split(":").map(Number) as [number, number];
  return Math.abs(facts.width * heightRatio - facts.height * widthRatio) > widthRatio + heightRatio
    ? `输出画幅 ${facts.width}x${facts.height} 与冻结比例 ${aspectRatio} 不符` : null;
}

/** 原声开关校验：native 必须有音轨，none 必须无声。 */
export function audioModeMismatch(facts: VideoFileFacts, audioMode: "none" | "native"): string | null {
  if (audioMode === "native" && !facts.hasAudio) return "输出无声音轨，与原生音画要求不符";
  if (audioMode === "none" && facts.hasAudio) return "输出含声音轨，与冻结的无声要求不符";
  return null;
}
