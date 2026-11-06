import { existsSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, ModelBinding, OperationSpec, RecoveryQuery, InputRef, MarkdownContent } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { digestOf, type AgentClock } from "./util.js";
import type { ArkVideoProfile } from "./media-config.js";
import { getRevisionRow } from "./artifact-store.js";
import { LocalRenderPort } from "./local-render.js";
import {
  audioModeMismatch, durationMismatch, PortObservations, ProviderHttpError, providerRequestJson, settleDownloadedVideo, validateHttpUrl,
} from "./media-port-support.js";
import { markdownFullText } from "../../shared/agent/markdown.js";

// Ark Seedance 薄适配：submit 只等创建回执并立即保存 task ID；query 只 GET 原任务；
// 不调用 DELETE（取消/删除复合语义）；终态账务不进入周期供应商查询；无 task ID 的 unknown 稳定返回。
// generate_audio 按冻结 audioMode 传递（none→false，native→true），成片按同一开关验收音轨。
// 凭据与地址按每次调用的冻结绑定从设置版本解析；本文件不读凭据文件、不把 Authorization 写进观测或日志。

/** 按冻结绑定解析该次调用的执行配置与原 Key；返回 null 表示绑定不在本部署历史（漂移）。 */
export type ArkBindingResolver = (binding: ModelBinding) => { profile: ArkVideoProfile; apiKey: string | null } | null;

export interface ArkMediaPortOptions {
  resolve: ArkBindingResolver;
  /** 尝试工作目录（确定性下载位置：<workRoot>/<attemptId>/download.mp4）。 */
  workRoot: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxDownloadBytes?: number;
}

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

interface ArkTask {
  id?: unknown;
  status?: unknown;
  content?: unknown;
  usage?: unknown;
  error?: { code?: unknown; message?: unknown };
}

export class ArkMediaPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: ArkMediaPortOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.observations = new PortObservations(db, clock, "ark");
  }

  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "video") throw new Error("Ark 通道只接受 video 操作。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) {
      return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    }
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "媒体凭据未启用；未提交任何请求，不会自动重试。");
    // 输入已经过能力校验，worker 已核对冻结修订；这里直接读取正文，不重新核对整份执行对象。
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const prompt = ref.kind === "text" ? ref.text : markdownFullText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const parameters = input.operation.parameters;
    let observation: ExecutionObservation;
    try {
      const response = await providerRequestJson("POST", new URL(`${resolved.profile.baseUrl}/contents/generations/tasks`),
        resolved.apiKey, {
          model: resolved.profile.modelId,
          content: [{ type: "text", text: prompt }],
          ratio: parameters.aspectRatio,
          duration: parameters.durationSeconds,
          resolution: parameters.resolution,
          generate_audio: parameters.audioMode !== "none",
          watermark: false,
        }, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs }) as ArkTask;
      const taskId = typeof response.id === "string" && response.id.trim() ? response.id.trim() : null;
      if (!taskId) return this.observations.unstableUnknown(input.attemptId, null, "创建响应缺少任务 ID，结果未核实；不会重新提交。");
      // 先持久任务身份，再返回 running；两者之间中断可凭收据恢复查询。
      this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId, { providerTaskId: taskId }))();
      observation = {
        observationId: `obs-${digestOf({ attemptId: input.attemptId, scope: "ark-submit", taskId }).slice(0, 24)}`,
        attemptId: input.attemptId, state: "running", providerTaskId: taskId, blob: null,
        observedAt: this.clock(), message: "供应商已受理，任务在后台执行。", billing: null,
      };
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        return this.preRefusal(input.attemptId, `供应商明确拒绝创建任务：${error.message}`);
      }
      // 超时、断连、5xx：无法证明未受理 → unknown，不自动重试 POST。
      return this.observations.unstableUnknown(input.attemptId, null,
        `创建请求结果未核实（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原身份核对，不会重新提交。`);
    }
    return observation;
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    // 先消费已经写入的创建收据；结果事务尚未落库时仍用原 task ID 恢复。
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
    let task: ArkTask;
    try {
      task = await providerRequestJson("GET",
        new URL(`${resolved.profile.baseUrl}/contents/generations/tasks/${encodeURIComponent(query.providerTaskId)}`),
        resolved.apiKey, undefined, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs }) as ArkTask;
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        if (error.status === 404) {
          return this.observations.stableUnknown(query.attemptId, "任务记录已不可查询（超过供应商保留期），结果无法核实；不会重新提交。", query.providerTaskId);
        }
        // 其余明确拒绝（鉴权/权限等）不会自行恢复：稳定 unknown，不产生逐轮新事实。
        return this.observations.stableUnknown(query.attemptId, `任务查询被拒绝：${error.message}；结果无法自动核实，不会重新提交。`, query.providerTaskId);
      }
      return this.observations.unstableUnknown(query.attemptId, query.providerTaskId,
        `查询暂时失败（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原任务身份继续核对。`);
    }
    const status = typeof task.status === "string" ? task.status : "";
    if (status === "queued" || status === "running") {
      return {
        observationId: `obs-${digestOf({ attemptId: query.attemptId, scope: "ark-running", at: this.clock() }).slice(0, 24)}`,
        attemptId: query.attemptId, state: "running", providerTaskId: query.providerTaskId, blob: null,
        observedAt: this.clock(), message: status === "queued" ? "任务排队中。" : "任务执行中。", billing: null,
      };
    }
    if (status === "failed" || status === "expired") {
      const reason = [task.error?.code, task.error?.message].filter(value => typeof value === "string").join("：").replaceAll(resolved.apiKey, "[已隐去凭据]");
      const detail = reason ? `供应商任务${status === "expired" ? "超时" : "失败"}：${reason}`
        : status === "expired" ? "供应商任务超时（expired）。" : "供应商任务失败，未返回具体原因。";
      return this.observations.deterministic(query.attemptId, "failed", query.providerTaskId, detail);
    }
    if (status === "cancelled") {
      return this.observations.deterministic(query.attemptId, "cancelled", query.providerTaskId, "供应商任务已取消。");
    }
    if (status !== "succeeded") {
      return this.observations.stableUnknown(query.attemptId, "未识别的供应商任务状态；保留原身份，不猜测结果。", query.providerTaskId);
    }
    // 供应商完成 ≠ 成品合规：下载到确定性位置、探测后再决定成败。
    return this.settleDownload(query, task);
  }

  // Ark 的 DELETE 兼具删除语义，本通道不调用：停止只反映为“已提交任务尚未确认取消”。
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  // —— 内部 ——

  private settleDownload(query: ProviderRecoveryQuery, task?: ArkTask): Promise<ExecutionObservation> {
    const content = task?.content as { video_url?: unknown } | undefined;
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    return settleDownloadedVideo({
      db: this.db, blobs: this.blobs, observations: this.observations,
      attemptId: query.attemptId, runId: query.runId, operationId: query.operationId, providerTaskId: query.providerTaskId,
      attemptDir, finalFile: path.join(attemptDir, "download.mp4"),
      ...(task ? { download: { url: validateHttpUrl(content?.video_url), fetchImpl: this.fetchImpl,
        downloadTimeoutMs: this.options.downloadTimeoutMs, maxDownloadBytes: this.options.maxDownloadBytes } } : {}),
      // Seedance 冻结 720p/16:9：按像素与时长验收；音轨按冻结 audioMode（native 必须有声、none 必须无声）。
      validate: (facts, op) => (facts.width !== 1280 || facts.height !== 720
        ? `输出画幅 ${facts.width}x${facts.height} 与冻结参数 1280x720 不符。` : null)
        ?? durationMismatch(facts, op.parameters.durationSeconds)
        ?? audioModeMismatch(facts, op.parameters.audioMode),
      retryMessage: "任务已完成，视频文件暂未完成取得或校验；保留已有文件和任务身份继续核对，不重新生成。",
    });
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    return this.observations.deterministic(attemptId, "failed", null, message);
  }
}

// 组合网关：render 走本地端口；其余操作/查询/取消一律按冻结 binding 解析到唯一已知端口。
// 未识别的旧绑定不落“否则就是 Ark”的默认分支——明确退役 unknown，绝不回落其他通道。
export interface RealMediaGatewayOptions {
  /** 冻结 binding → 执行端口；覆盖全部已装配的供应商通道（含 Ark 视频）。未命中返回 null。 */
  resolveProviderPort: (binding: ModelBinding) => MediaExecutionPort | null;
  /** 退役通道路由的观测时间来源；未提供时用当前时间。 */
  clock?: AgentClock;
}

export class RealMediaGateway implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  constructor(private readonly local: LocalRenderPort, private readonly options: RealMediaGatewayOptions) {}
  submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    if (input.operation.kind === "render") return this.local.submit(input, permit, signal);
    // 视频供应商同样按冻结绑定路由（Ark/MiniMax/万相），不再默认 Ark。
    const port = this.options.resolveProviderPort(input.operation.model);
    if (!port) throw new Error("网关未装配该操作绑定对应的执行通道。");
    // 各端口自行决定是否消费 signal（配音/图片中止本地等待；视频保留已提交任务）。
    return port.submit(input, permit, signal);
  }
  query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind === "local") return this.local.query(query);
    return this.routeProvider(query, port => port.query(query));
  }
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind === "local") return this.local.cancel(query);
    return this.routeProvider(query, port => port.cancel(query));
  }
  private routeProvider(query: ProviderRecoveryQuery, dispatch: (port: MediaExecutionPort) => Promise<ExecutionObservation>): Promise<ExecutionObservation> {
    const port = this.options.resolveProviderPort(query.accountBinding);
    if (port) return dispatch(port);
    // 旧供应商绑定已退役：没有可查询的执行通道，也不得用其他通道冒充核对结果。
    return Promise.resolve({
      observationId: `obs-${digestOf({ attemptId: query.attemptId, scope: "gateway-retired", binding: query.accountBinding }).slice(0, 24)}`,
      attemptId: query.attemptId, state: "unknown", providerTaskId: null, blob: null,
      observedAt: this.options.clock?.() ?? new Date().toISOString(),
      message: "该尝试绑定的旧媒体通道已退役，结果无法核实；不会重新提交。", billing: null,
    });
  }
  async close(): Promise<void> {
    await this.local.close();
  }
}
