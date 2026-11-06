import { existsSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, InputRef, MarkdownContent, ModelBinding, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { digestOf, type AgentClock } from "./util.js";
import type { MiniMaxVideoProfile } from "./media-config.js";
import { getRevisionRow } from "./artifact-store.js";
import {
  aspectRatioMismatch, audioModeMismatch, durationMismatch, PortObservations, ProviderHttpError, providerRequestJson, settleDownloadedVideo, validateHttpUrl,
} from "./media-port-support.js";
import { markdownFullText } from "../../shared/agent/markdown.js";

// MiniMax H3/H3-Max 薄适配（wire 序列按 2026-11-01 官方 v2 页面核实）：
// POST /v2/video_generation {model, content:[{type:"text"}], resolution("768P"), ratio, duration} → {task_id}；
// GET /v2/query/video_generation/{task_id} → {task:{status, content:{url}}}（status queued/running/
// succeeded/failed/cancelled，结果 7 天内可查）。官方 create 页无静音字段——不猜 audio 开关，
// native 音画按冻结参数验收（有声轨 + 时长）。停止不调用 DELETE（该端点兼具删除语义）：
// 只保留原 taskId 查询后续事实。凭据按冻结绑定从版本表解析，不写 Authorization 进观测。

export type MiniMaxVideoBindingResolver = (binding: ModelBinding) => { profile: MiniMaxVideoProfile; apiKey: string | null } | null;

export interface MiniMaxVideoPortOptions {
  resolve: MiniMaxVideoBindingResolver;
  /** 尝试工作目录（确定性下载位置：<workRoot>/<attemptId>/download.mp4）。 */
  workRoot: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
}

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

interface MiniMaxQueryTask {
  status?: unknown;
  content?: unknown;
}

export class MiniMaxVideoPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: MiniMaxVideoPortOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.observations = new PortObservations(db, clock, "minimax-video");
  }

  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "video") throw new Error("MiniMax 通道只接受 video 操作。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "媒体凭据未启用；未提交任何请求，不会自动重试。");
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const prompt = ref.kind === "text" ? ref.text : markdownFullText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const parameters = input.operation.parameters;
    let taskId: string;
    try {
      const response = await providerRequestJson("POST", new URL(`${resolved.profile.baseUrl}/v2/video_generation`), resolved.apiKey, {
        model: resolved.profile.modelId,
        content: [{ type: "text", text: prompt }],
        resolution: parameters.resolution,
        ratio: parameters.aspectRatio,
        duration: parameters.durationSeconds,
      }, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs });
      const id = typeof response.task_id === "string" ? response.task_id.trim() : "";
      if (!id) return this.observations.unstableUnknown(input.attemptId, null, "创建响应缺少任务 ID，结果未核实；不会重新提交。");
      taskId = id;
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        return this.preRefusal(input.attemptId, `供应商明确拒绝创建任务：${error.message}`);
      }
      return this.observations.unstableUnknown(input.attemptId, null,
        `创建请求结果未核实（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原身份核对，不会重新提交。`);
    }
    // 先持久任务身份，再返回 running；两者之间中断可凭收据恢复查询。
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId, { providerTaskId: taskId }))();
    return {
      observationId: `obs-${digestOf({ attemptId: input.attemptId, scope: "minimax-video-submit", taskId }).slice(0, 24)}`,
      attemptId: input.attemptId, state: "running", providerTaskId: taskId, blob: null,
      observedAt: this.clock(), message: "供应商已受理，任务在后台执行。", billing: null,
    };
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    query = { ...query, providerTaskId: query.providerTaskId ?? receipt?.provider_task_id ?? null };
    // 已有有效成品收据：直接复用，避免重启后重复下载与重复发布。
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
    let task: MiniMaxQueryTask;
    try {
      const response = await providerRequestJson("GET",
        new URL(`${resolved.profile.baseUrl}/v2/query/video_generation/${encodeURIComponent(query.providerTaskId)}`),
        resolved.apiKey, undefined, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs });
      task = (typeof response.task === "object" && response.task !== null ? response.task : {}) as MiniMaxQueryTask;
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        if (error.status === 404) {
          return this.observations.stableUnknown(query.attemptId, "任务记录已不可查询（官方保留期约 7 天），结果无法核实；不会重新提交。", query.providerTaskId);
        }
        return this.observations.stableUnknown(query.attemptId, `任务查询被拒绝：${error.message}；结果无法自动核实，不会重新提交。`, query.providerTaskId);
      }
      return this.observations.unstableUnknown(query.attemptId, query.providerTaskId,
        `查询暂时失败（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原任务身份继续核对。`);
    }
    const status = typeof task.status === "string" ? task.status : "";
    if (status === "queued" || status === "running") {
      return {
        observationId: `obs-${digestOf({ attemptId: query.attemptId, scope: "minimax-video-running", at: this.clock() }).slice(0, 24)}`,
        attemptId: query.attemptId, state: "running", providerTaskId: query.providerTaskId, blob: null,
        observedAt: this.clock(), message: status === "queued" ? "任务排队中。" : "任务执行中。", billing: null,
      };
    }
    if (status === "failed") return this.observations.deterministic(query.attemptId, "failed", query.providerTaskId, "供应商任务失败。");
    if (status === "cancelled") return this.observations.deterministic(query.attemptId, "cancelled", query.providerTaskId, "供应商任务已取消。");
    if (status !== "succeeded") {
      return this.observations.stableUnknown(query.attemptId, "未识别的供应商任务状态；保留原身份，不猜测结果。", query.providerTaskId);
    }
    return this.settleDownload(query, task);
  }

  // 普通停止不调用 DELETE：该端点兼具删除已完成记录的语义，可能吞掉结果；
  // 停止只表示宿主不再等待，保留原 taskId 并以查询取得后续事实。
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  // —— 内部 ——

  private settleDownload(query: ProviderRecoveryQuery, task?: MiniMaxQueryTask): Promise<ExecutionObservation> {
    const content = task?.content as { url?: unknown } | undefined;
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    return settleDownloadedVideo({
      db: this.db, blobs: this.blobs, observations: this.observations,
      attemptId: query.attemptId, runId: query.runId, operationId: query.operationId, providerTaskId: query.providerTaskId,
      attemptDir, finalFile: path.join(attemptDir, "download.mp4"),
      ...(task ? { download: { url: validateHttpUrl(content?.url), fetchImpl: this.fetchImpl,
        downloadTimeoutMs: this.options.downloadTimeoutMs, maxDownloadBytes: this.options.maxDownloadBytes } } : {}),
      // 精确像素规格待账户样本核实；冻结的 16:9 比例仍必须在文件边界验收。
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
