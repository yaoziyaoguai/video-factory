import { existsSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, InputRef, MarkdownContent, ModelBinding, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { digestOf, type AgentClock } from "./util.js";
import type { WanVideoProfile } from "./media-config.js";
import { getRevisionRow } from "./artifact-store.js";
import {
  aspectRatioMismatch, audioModeMismatch, durationMismatch, PortObservations, ProviderHttpError, providerRequestJson, settleDownloadedVideo, validateHttpUrl,
} from "./media-port-support.js";
import { markdownFullText } from "../../shared/agent/markdown.js";

// 阿里万相 wan3.0-video/-prime 薄适配（wire 序列按 2026-11-01 百炼官方页核实）：
// POST {workspace 媒体 baseUrl}/api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
// {model, input:{prompt}, parameters:{audio, prompt_extend:false, duration, resolution, ratio}} → {output:{task_id}}；
// GET /api/v1/tasks/{id} → {output:{task_status PENDING/RUNNING/SUCCEEDED/FAILED/CANCELED/UNKNOWN, video_url}}。
// prompt_extend 显式 false：不让额外模型改写已认可 prompt。取消 POST /api/v1/tasks/{id}/cancel 仅接受
// PENDING；明确成功才记远端取消，拒绝/超时落回原任务查询。UNKNOWN 不判失败、不重发。凭据不进观测。

export type WanVideoBindingResolver = (binding: ModelBinding) => { profile: WanVideoProfile; apiKey: string | null } | null;

export interface WanVideoPortOptions {
  resolve: WanVideoBindingResolver;
  /** 尝试工作目录（确定性下载位置：<workRoot>/<attemptId>/download.mp4）。 */
  workRoot: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
}

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

export class WanVideoPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: WanVideoPortOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.observations = new PortObservations(db, clock, "wan-video");
  }

  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "video") throw new Error("万相通道只接受 video 操作。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "媒体凭据未启用；未提交任何请求，不会自动重试。");
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const prompt = ref.kind === "text" ? ref.text : markdownFullText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const parameters = input.operation.parameters;
    let taskId: string;
    try {
      const response = await providerRequestJson("POST",
        new URL(`${resolved.profile.baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`),
        resolved.apiKey,
        {
          model: resolved.profile.modelId,
          input: { prompt },
          parameters: {
            audio: parameters.audioMode !== "none",
            prompt_extend: false,
            duration: parameters.durationSeconds,
            resolution: parameters.resolution,
            ratio: parameters.aspectRatio,
          },
        },
        { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs, headers: { "X-DashScope-Async": "enable" } });
      const output = typeof response.output === "object" && response.output !== null ? response.output as { task_id?: unknown } : {};
      const id = typeof output.task_id === "string" ? output.task_id.trim() : "";
      if (!id) return this.observations.unstableUnknown(input.attemptId, null, "创建响应缺少任务 ID，结果未核实；不会重新提交。");
      taskId = id;
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        return this.preRefusal(input.attemptId, `供应商明确拒绝创建任务：${error.message}`);
      }
      return this.observations.unstableUnknown(input.attemptId, null,
        `创建请求结果未核实（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原身份核对，不会重新提交。`);
    }
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId, { providerTaskId: taskId }))();
    return {
      observationId: `obs-${digestOf({ attemptId: input.attemptId, scope: "wan-video-submit", taskId }).slice(0, 24)}`,
      attemptId: input.attemptId, state: "running", providerTaskId: taskId, blob: null,
      observedAt: this.clock(), message: "供应商已受理，任务在后台执行。", billing: null,
    };
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    query = { ...query, providerTaskId: query.providerTaskId ?? receipt?.provider_task_id ?? null };
    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          return this.observations.deterministicSucceeded(query.attemptId, query.providerTaskId, blob.id, blob.digest);
        } catch { /* 成品文件缺失：继续走查询/下载路径 */ }
      }
    }
    if (receipt?.exit_kind === "failed") {
      return this.observations.deterministic(query.attemptId, "failed", query.providerTaskId, receipt.detail ?? "已取得的输出不满足冻结参数。");
    }
    if (existsSync(path.join(this.options.workRoot, query.attemptId, "download.mp4"))) return this.settleDownload(query);
    const resolved = this.options.resolve(query.accountBinding);
    if (!resolved) {
      return this.observations.stableUnknown(query.attemptId, "账号配置已变化；保留原任务身份，未使用当前配置查询，也不会重新创建。", query.providerTaskId);
    }
    if (!resolved.apiKey) return this.observations.stableUnknown(query.attemptId, "媒体凭据未启用，无法查询；不会重新提交。", query.providerTaskId);
    if (!query.providerTaskId) return this.observations.stableUnknown(query.attemptId, "缺少供应商任务身份，无法向供应商查询；结果与实际费用未取得；不会重新提交。");
    let output: { task_status?: unknown; video_url?: unknown; code?: unknown };
    try {
      const response = await providerRequestJson("GET", new URL(`${resolved.profile.baseUrl}/api/v1/tasks/${encodeURIComponent(query.providerTaskId)}`),
        resolved.apiKey, undefined, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs });
      output = typeof response.output === "object" && response.output !== null
        ? response.output as { task_status?: unknown; video_url?: unknown; code?: unknown } : {};
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        return this.observations.stableUnknown(query.attemptId,
          `任务查询被拒绝：${error.message}；结果无法自动核实，不会重新提交。`, query.providerTaskId);
      }
      return this.observations.unstableUnknown(query.attemptId, query.providerTaskId,
        `查询暂时失败（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原任务身份继续核对。`);
    }
    switch (typeof output.task_status === "string" ? output.task_status : "") {
      case "PENDING":
      case "RUNNING":
        return {
          observationId: `obs-${digestOf({ attemptId: query.attemptId, scope: "wan-video-running", at: this.clock() }).slice(0, 24)}`,
          attemptId: query.attemptId, state: "running", providerTaskId: query.providerTaskId, blob: null,
          observedAt: this.clock(), message: output.task_status === "PENDING" ? "任务排队中。" : "任务执行中。", billing: null,
        };
      case "FAILED":
        return this.observations.deterministic(query.attemptId, "failed", query.providerTaskId,
          `供应商任务失败${typeof output.code === "string" ? `（${output.code}）` : ""}。`);
      case "CANCELED":
        return this.observations.deterministic(query.attemptId, "cancelled", query.providerTaskId, "供应商任务已取消。");
      case "SUCCEEDED":
        return this.settleDownload(query, output);
      default:
        // 官方枚举含 UNKNOWN（不存在或状态未知）：保留原身份，不判失败、不重发。
        return this.observations.stableUnknown(query.attemptId, "任务状态未知（UNKNOWN）或未识别；保留原身份，不猜测结果。", query.providerTaskId);
    }
  }

  // 取消仅接受 PENDING：明确成功才记远端取消；拒绝（非 PENDING）/超时落回原任务查询，保留查询事实，
  // 不把本地停止当远端取消，也不因此重新创建。
  async cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    const taskId = query.providerTaskId ?? receipt?.provider_task_id ?? null;
    if (!taskId) return this.observations.stableUnknown(query.attemptId, "缺少供应商任务身份，无法向供应商请求取消；不会重新提交。");
    const resolved = this.options.resolve(query.accountBinding);
    if (!resolved?.apiKey) {
      return this.observations.stableUnknown(query.attemptId, "账号配置已变化或凭据未启用，无法请求取消；保留原任务身份。", taskId);
    }
    try {
      await providerRequestJson("POST", new URL(`${resolved.profile.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`),
        resolved.apiKey, undefined, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs });
      return this.observations.deterministic(query.attemptId, "cancelled", taskId, "供应商已取消排队中的任务。");
    } catch {
      // 拒绝/超时/断连：不猜测远端状态，按原任务查询取得后续事实。
      return this.query(query);
    }
  }

  // —— 内部 ——

  private settleDownload(query: ProviderRecoveryQuery, output?: { video_url?: unknown }): Promise<ExecutionObservation> {
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    return settleDownloadedVideo({
      db: this.db, blobs: this.blobs, observations: this.observations,
      attemptId: query.attemptId, runId: query.runId, operationId: query.operationId, providerTaskId: query.providerTaskId,
      attemptDir, finalFile: path.join(attemptDir, "download.mp4"),
      ...(output ? { download: { url: validateHttpUrl(output.video_url), fetchImpl: this.fetchImpl,
        downloadTimeoutMs: this.options.downloadTimeoutMs, maxDownloadBytes: this.options.maxDownloadBytes } } : {}),
      // 不猜 720P 的精确像素；冻结的画幅比例与新下载/完整文件恢复共用验收。
      validate: (facts, op) => aspectRatioMismatch(facts, op.parameters.aspectRatio)
        ?? durationMismatch(facts, op.parameters.durationSeconds)
        ?? audioModeMismatch(facts, op.parameters.audioMode),
      retryMessage: "任务已完成，视频文件暂未完成取得或校验；保留已有文件和任务身份继续核对，不重新生成。",
    });
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    return this.observations.deterministic(attemptId, "failed", null, message);
  }
}
