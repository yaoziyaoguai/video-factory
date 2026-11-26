import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExecutionInput,
  ExecutionObservation,
  ModelBinding,
  OperationSpec,
  ProviderUsage,
  RecoveryQuery,
} from "../../shared/agent/generated/contracts.js";
import { markdownFullText } from "../../shared/agent/markdown.js";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { MarkdownContent } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import { AgentError } from "./errors.js";
import type { ColabVideoProfile } from "./media-config.js";
import {
  aspectRatioMismatch,
  audioModeMismatch,
  PortObservations,
  settleDownloadedVideo,
  withZeroCostBilling,
} from "./media-port-support.js";
import { InvalidImageFile, probeImageFile, type VideoFileFacts } from "./media-probe.js";
import type { ProductionBlobs } from "./production-blobs.js";
import {
  attemptOutput,
  completedUsage,
  operationsFor,
  recordAttemptOutput,
  runRow,
} from "./production-store.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { digestOf, type AgentClock } from "./util.js";
import { videoImageSlots } from "./video-image-inputs.js";

export type ColabBindingResolver = (
  binding: ModelBinding,
) => { profile: ColabVideoProfile; apiKey: string | null } | null;

export interface ColabLtxVideoPortOptions {
  resolve: ColabBindingResolver;
  /** 尝试工作目录（确定性下载位置：<workRoot>/<attemptId>/download.mp4）。 */
  workRoot: string;
  /** 受控 Python 执行器绝对路径（由入口按已确定的仓库根注入）。 */
  executorScriptPath: string;
  pythonBin?: string;
  /** 执行器账本与隔离会话配置目录。 */
  stateDir?: string;
  colabBin?: string;
  colabAuth?: "oauth2" | "adc";
  colabConfigPath?: string;
  mountDrive?: boolean;
  driveCacheDir?: string;
  gpu?: "T4" | "L4" | "G4" | "A100" | "H100";
  gpuFallbacks?: string;
  /** 仅测试显式注入：零额度回归样片路径；生产运行绝不启用静默回退。 */
  replaySampleMp4Path?: string;
  /** 仅测试显式注入：远端模拟生成样片路径。 */
  mockRemoteMp4Path?: string;
  commandTimeoutMs?: number;
}

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;
type ColabVideoOp = Extract<OperationSpec, { kind: "video" }>;

interface ExecutorResponse {
  ok?: boolean;
  state?: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  preSubmitRefusal?: boolean;
  notAllocated?: boolean;
  sampleReplay?: boolean;
  stableUnknown?: boolean;
  attemptId?: string;
  providerTaskId?: string | null;
  outputMp4Path?: string;
  message?: string;
  error?: string;
  usage?: ProviderUsage;
}

export const COLAB_EXECUTOR_RELATIVE_PATH = ".agents/skills/colab-ltx-video/scripts/colab_ltx.py";

const NOMINAL_DIMS: Record<"720p" | "1080p", Record<"16:9" | "9:16", [number, number]>> = {
  "720p": { "16:9": [1280, 720], "9:16": [720, 1280] },
  "1080p": { "16:9": [1920, 1080], "9:16": [1080, 1920] },
};

function colabOutputMismatch(facts: VideoFileFacts, parameters: ColabVideoOp["parameters"]): string | null {
  if (parameters.aspectRatio !== "16:9" && parameters.aspectRatio !== "9:16") {
    return `Colab LTX-2.5 不支持冻结比例 ${parameters.aspectRatio}`;
  }
  const resKey = parameters.resolution.toLowerCase() === "1080p" ? "1080p" : "720p";
  const [expectedW, expectedH] = NOMINAL_DIMS[resKey][parameters.aspectRatio];
  const ratioErr = aspectRatioMismatch(facts, parameters.aspectRatio, 32);
  if (ratioErr) return ratioErr;
  const shortSide = Math.min(facts.width, facts.height);
  const floor = Math.min(expectedW, expectedH) - 32;
  if (shortSide < floor) {
    return `输出短边 ${shortSide} 像素，低于冻结 ${parameters.resolution} 档下限 ${floor}`;
  }
  // LTX-2.5 采用 8*k+1 因果帧网格（如 5s @ 24fps = 121 帧 ≈ 5042ms），允许 2 帧容差。
  const expectedMs = parameters.durationSeconds * 1000;
  const toleranceMs = Math.max(100, Math.ceil(1000 / (facts.frameRate ?? 24)) * 2);
  if (Math.abs(facts.videoDurationMs - expectedMs) > toleranceMs) {
    return `输出时长 ${facts.videoDurationMs} ms 与冻结秒数 ${expectedMs} ms 不符（容差 ${toleranceMs} ms）`;
  }
  return audioModeMismatch(facts, parameters.audioMode);
}

function redactToken(text: string, secret: string | null): string {
  let clean = text;
  if (secret && secret.length >= 4 && secret !== "host") {
    clean = clean.replaceAll(secret, "[已隐去凭据]");
  }
  return clean.replace(/\bhf_[A-Za-z0-9]{8,}\b/g, "[已隐去凭据]").trim();
}

export class ColabLtxVideoPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = false;
  readonly executorPath: string;
  private readonly observations: PortObservations;
  private readonly pythonBin: string;

  constructor(
    private readonly db: AgentDatabase,
    private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock,
    private readonly options: ColabLtxVideoPortOptions,
  ) {
    this.observations = new PortObservations(db, clock, "colab-ltx");
    this.executorPath = options.executorScriptPath;
    this.pythonBin = options.pythonBin ?? "python3";
  }

  queryRequiresProviderTaskIdFor(): boolean {
    return false;
  }

  async submit(input: ExecutionInput, permit: SubmitPermit): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "video") throw new Error("Colab LTX 通道只接受 video 操作。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) {
      return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前配置提交 Colab 任务。");
    }
    if (!resolved.apiKey) {
      return this.preRefusal(input.attemptId, "Colab 通道凭据未启用；未发起任何 GPU 分配。");
    }

    let stagedInput: { firstFrameFile: string; prompt: string };
    try {
      stagedInput = await this.stageFrozenInputs(input);
    } catch (error) {
      if (error instanceof AgentError || error instanceof InvalidImageFile) {
        return this.preRefusal(input.attemptId, error.message);
      }
      throw error;
    }

    const params = input.operation.parameters;
    const preset = params.resolution.toLowerCase() === "1080p" ? "1080p" : "720p";
    const batch = this.batchContextFor(input.runId, input.operation.operationId, input.operation.model);
    const hfToken = resolved.apiKey === "host" ? "" : resolved.apiKey;

    const args = [
      "submit",
      ...this.commonArgs(),
      "--attempt-id",
      input.attemptId,
      "--request-identity",
      input.requestIdentity,
      "--run-id",
      input.runId,
      "--first-frame",
      stagedInput.firstFrameFile,
      "--prompt",
      stagedInput.prompt,
      "--preset",
      preset,
      "--aspect",
      params.aspectRatio,
      "--duration-sec",
      String(params.durationSeconds),
      "--model-revision",
      resolved.profile.modelRevision,
      ...(params.audioMode === "none" ? ["--mute-audio"] : []),
      ...(batch.totalShots > 1
        ? ["--batch-id", input.runId, "--batch-total-shots", String(batch.totalShots), "--shot-seq", String(batch.shotSeq)]
        : []),
      ...(this.options.gpu ? ["--gpu", this.options.gpu] : []),
      ...(this.options.gpuFallbacks ? ["--gpu-fallbacks", this.options.gpuFallbacks] : []),
      ...(this.options.mountDrive ?? resolved.profile.mountDrive ? ["--mount-drive"] : []),
      ...(this.options.driveCacheDir ? ["--drive-cache-dir", this.options.driveCacheDir] : []),
      ...(hfToken ? ["--hf-token-stdin"] : []),
      ...(this.options.replaySampleMp4Path ? ["--replay-sample-mp4", this.options.replaySampleMp4Path] : []),
      ...(this.options.mockRemoteMp4Path ? ["--mock-remote-mp4", this.options.mockRemoteMp4Path] : []),
    ];

    let resp: ExecutorResponse;
    try {
      resp = await this.invokeExecutor(args, hfToken || undefined);
    } catch (error) {
      const detail = redactToken(error instanceof Error ? error.message : String(error), resolved.apiKey);
      return this.observations.unstableUnknown(
        input.attemptId,
        null,
        `Colab 执行器调用中断（${detail}）；将通过本地账本核对实例归属，不会重复分配。`,
      );
    }

    const taskId = typeof resp.providerTaskId === "string" && resp.providerTaskId.trim() ? resp.providerTaskId.trim() : null;
    if (taskId || resp.usage) {
      this.db.transaction(() =>
        recordAttemptOutput(this.db, this.clock(), input.attemptId, {
          ...(taskId ? { providerTaskId: taskId } : {}),
          ...(resp.usage ? { usage: resp.usage } : {}),
        }),
      )();
    }

    if (resp.state === "failed") {
      const msg = redactToken(resp.message ?? resp.error ?? "Colab 任务提交失败。", resolved.apiKey);
      if (resp.preSubmitRefusal) return this.preRefusal(input.attemptId, msg);
      const obs = this.withUsage(this.observations.deterministic(input.attemptId, "failed", taskId, msg), resp.usage);
      return this.isSampleReplay(taskId, resp.usage, resp.sampleReplay) ? withZeroCostBilling(obs) : obs;
    }
    if (resp.state === "cancelled") {
      const obs = this.withUsage(
        this.observations.deterministic(input.attemptId, "cancelled", taskId, resp.message ?? "任务已取消。"),
        resp.usage,
      );
      return resp.notAllocated || this.isSampleReplay(taskId, resp.usage, resp.sampleReplay)
        ? withZeroCostBilling(obs)
        : obs;
    }
    if (resp.state === "unknown") {
      const msg = redactToken(resp.message ?? "Colab GPU 分配结果待核实。", resolved.apiKey);
      return resp.stableUnknown
        ? this.observations.stableUnknown(input.attemptId, msg, taskId)
        : this.observations.unstableUnknown(input.attemptId, taskId, msg);
    }
    if (resp.state === "succeeded" && resp.outputMp4Path) {
      return this.settleFromExecutorFile(
        {
          kind: "provider",
          runId: input.runId,
          operationId: input.operation.operationId,
          attemptId: input.attemptId,
          requestIdentity: input.requestIdentity,
          accountBinding: input.operation.model,
          providerTaskId: taskId,
        },
        resp.outputMp4Path,
        resp.usage,
        resp.sampleReplay,
      );
    }

    return {
      observationId: `obs-${digestOf({ attemptId: input.attemptId, scope: "colab-submit", taskId }).slice(0, 24)}`,
      attemptId: input.attemptId,
      state: "running",
      providerTaskId: taskId,
      blob: null,
      observedAt: this.clock(),
      message: "Colab LTX-2.5 作业已启动，正在云端 GPU 生成。",
      billing: null,
    };
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") {
      return this.observations.stableUnknown(query.attemptId, "查询类型与 Colab 通道不匹配。");
    }
    const receipt = attemptOutput(this.db, query.attemptId);
    const effectiveTaskId = query.providerTaskId ?? receipt?.provider_task_id ?? null;
    const priorUsage = completedUsage(this.db, query.attemptId).usage;

    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          const obs = this.withUsage(
            this.observations.deterministicSucceeded(query.attemptId, effectiveTaskId, blob.id, blob.digest),
            priorUsage,
          );
          return this.isSampleReplay(effectiveTaskId, priorUsage) ? withZeroCostBilling(obs) : obs;
        } catch {
          // 成品缺失时继续从本地下载目录或执行器账本恢复
        }
      }
    }
    if (receipt?.exit_kind === "failed") {
      const obs = this.withUsage(
        this.observations.deterministic(
          query.attemptId,
          "failed",
          effectiveTaskId,
          receipt.detail ?? "已取得的输出不满足冻结参数。",
        ),
        priorUsage,
      );
      return this.isSampleReplay(effectiveTaskId, priorUsage) ? withZeroCostBilling(obs) : obs;
    }

    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    const deterministicMp4 = path.join(attemptDir, "download.mp4");
    if (existsSync(deterministicMp4)) {
      return this.settleLocalDownload({ ...query, providerTaskId: effectiveTaskId }, priorUsage);
    }

    const releasePolicy = this.shouldKeepBatchWarm(query.runId, query.operationId, query.accountBinding)
      ? "keep_batch_warm"
      : "release_now";

    const args = [
      "query",
      ...this.commonArgs(),
      "--attempt-id",
      query.attemptId,
      "--request-identity",
      query.requestIdentity,
      "--release-policy",
      releasePolicy,
      ...(effectiveTaskId ? ["--provider-task-id", effectiveTaskId] : []),
    ];

    let resp: ExecutorResponse;
    try {
      resp = await this.invokeExecutor(args);
    } catch (error) {
      return this.observations.unstableUnknown(
        query.attemptId,
        effectiveTaskId,
        `查询本地 Colab 执行器暂时失败（${error instanceof Error ? error.message : String(error)}）；稍后重试。`,
      );
    }

    const taskId =
      (typeof resp.providerTaskId === "string" && resp.providerTaskId.trim() ? resp.providerTaskId.trim() : null) ??
      effectiveTaskId;
    if ((taskId && taskId !== receipt?.provider_task_id) || resp.usage) {
      this.db.transaction(() =>
        recordAttemptOutput(this.db, this.clock(), query.attemptId, {
          ...(taskId ? { providerTaskId: taskId } : {}),
          ...(resp.usage ? { usage: resp.usage } : {}),
        }),
      )();
    }

    if (resp.state === "running") {
      return {
        observationId: `obs-${digestOf({ attemptId: query.attemptId, scope: "colab-running", at: this.clock() }).slice(0, 24)}`,
        attemptId: query.attemptId,
        state: "running",
        providerTaskId: taskId,
        blob: null,
        observedAt: this.clock(),
        message: "Colab LTX-2.5 正在执行生成。",
        billing: null,
      };
    }
    if (resp.state === "failed") {
      const msg = resp.message ?? resp.error ?? "Colab 视频生成失败。";
      if (resp.preSubmitRefusal) return this.preRefusal(query.attemptId, msg);
      const obs = this.withUsage(this.observations.deterministic(query.attemptId, "failed", taskId, msg), resp.usage);
      return this.isSampleReplay(taskId, resp.usage, resp.sampleReplay) ? withZeroCostBilling(obs) : obs;
    }
    if (resp.state === "cancelled") {
      const obs = this.withUsage(
        this.observations.deterministic(
          query.attemptId,
          "cancelled",
          taskId,
          resp.message ?? "已取消并释放本单 Colab GPU。",
        ),
        resp.usage,
      );
      return resp.notAllocated || this.isSampleReplay(taskId, resp.usage, resp.sampleReplay)
        ? withZeroCostBilling(obs)
        : obs;
    }
    if (resp.state === "succeeded" && resp.outputMp4Path) {
      return this.settleFromExecutorFile(
        { ...query, providerTaskId: taskId },
        resp.outputMp4Path,
        resp.usage,
        resp.sampleReplay,
      );
    }

    const unknownMsg = resp.message ?? "Colab 任务状态未确认；保留原记录，不重复分配。";
    return resp.stableUnknown
      ? this.observations.stableUnknown(query.attemptId, unknownMsg, taskId)
      : this.observations.unstableUnknown(query.attemptId, taskId, unknownMsg);
  }

  async cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") {
      return this.observations.stableUnknown(query.attemptId, "取消类型与 Colab 通道不匹配。");
    }
    const receipt = attemptOutput(this.db, query.attemptId);
    const effectiveTaskId = query.providerTaskId ?? receipt?.provider_task_id ?? null;

    if (receipt?.blob_id && receipt.digest) {
      return this.query(query);
    }

    const args = [
      "cancel",
      ...this.commonArgs(),
      "--attempt-id",
      query.attemptId,
      "--request-identity",
      query.requestIdentity,
      ...(effectiveTaskId ? ["--provider-task-id", effectiveTaskId] : []),
    ];

    let resp: ExecutorResponse;
    try {
      resp = await this.invokeExecutor(args);
    } catch (error) {
      return this.observations.unstableUnknown(
        query.attemptId,
        effectiveTaskId,
        `取消 Colab 任务时执行器异常（${error instanceof Error ? error.message : String(error)}）。`,
      );
    }

    const taskId =
      (typeof resp.providerTaskId === "string" && resp.providerTaskId.trim() ? resp.providerTaskId.trim() : null) ??
      effectiveTaskId;
    if ((taskId && taskId !== receipt?.provider_task_id) || resp.usage) {
      this.db.transaction(() =>
        recordAttemptOutput(this.db, this.clock(), query.attemptId, {
          ...(taskId ? { providerTaskId: taskId } : {}),
          ...(resp.usage ? { usage: resp.usage } : {}),
        }),
      )();
    }

    if (resp.state === "succeeded" && resp.outputMp4Path) {
      return this.settleFromExecutorFile(
        { ...query, providerTaskId: taskId },
        resp.outputMp4Path,
        resp.usage,
        resp.sampleReplay,
      );
    }
    if (resp.state === "cancelled") {
      const obs = this.withUsage(
        this.observations.deterministic(
          query.attemptId,
          "cancelled",
          taskId,
          resp.message ?? "已取消并释放本单归属的 Colab GPU。",
        ),
        resp.usage,
      );
      return resp.notAllocated || this.isSampleReplay(taskId, resp.usage, resp.sampleReplay)
        ? withZeroCostBilling(obs)
        : obs;
    }
    const msg = resp.message ?? "尚未确认远端 Colab 会话停止，保留原状态核对。";
    return resp.stableUnknown
      ? this.observations.stableUnknown(query.attemptId, msg, taskId)
      : this.observations.unstableUnknown(query.attemptId, taskId, msg);
  }

  private commonArgs(): string[] {
    const stateDir = this.options.stateDir ?? path.join(this.options.workRoot, "_colab-ledger");
    const cfgPath = this.options.colabConfigPath ?? path.join(stateDir, "colab-sessions.json");
    return [
      "--state-dir",
      stateDir,
      "--colab-config",
      cfgPath,
      ...(this.options.colabBin ? ["--colab-bin", this.options.colabBin] : []),
      ...(this.options.colabAuth ? ["--colab-auth", this.options.colabAuth] : []),
    ];
  }

  private batchContextFor(
    runId: string,
    operationId: string,
    binding: ModelBinding,
  ): { totalShots: number; shotSeq: number } {
    const ops = operationsFor(this.db, runId)
      .map(row => ({ id: row.id, spec: JSON.parse(row.spec_json) as OperationSpec }))
      .filter(
        item =>
          item.spec.kind === "video" &&
          item.spec.model.providerId === "colab" &&
          item.spec.model.configurationRevisionId === binding.configurationRevisionId,
      );
    const idx = ops.findIndex(item => item.id === operationId);
    return { totalShots: ops.length, shotSeq: idx >= 0 ? idx + 1 : 1 };
  }

  private shouldKeepBatchWarm(runId: string, operationId: string, binding: ModelBinding): boolean {
    const run = runRow(this.db, runId);
    if (run.state === "cancel_requested" || run.state === "failed" || run.state === "cancelled") return false;
    const ops = operationsFor(this.db, runId);
    const colabOps = ops.filter(row => {
      const spec = JSON.parse(row.spec_json) as OperationSpec;
      return (
        spec.kind === "video" &&
        spec.model.providerId === "colab" &&
        spec.model.configurationRevisionId === binding.configurationRevisionId
      );
    });
    if (colabOps.length <= 1) return false;
    return colabOps.some(row => row.id !== operationId && (row.state === "pending" || row.state === "running"));
  }

  private async stageFrozenInputs(
    input: ExecutionInput,
  ): Promise<{ firstFrameFile: string; prompt: string }> {
    const op = input.operation;
    if (op.kind !== "video") throw new Error("冻结操作并非视频。");
    const slots = videoImageSlots(op.parameters);
    const firstSlot = slots.find(s => s.role === "first_frame");
    if (!firstSlot || slots.length !== 1) {
      throw new AgentError("CAPABILITY_UNAVAILABLE", "Colab LTX-2.5 需要且仅支持一张冻结首帧图与一份提示词。");
    }
    const textIndex = op.inputs.findIndex((_, idx) => idx !== firstSlot.slot);
    const textRef = textIndex >= 0 ? op.inputs[textIndex] : undefined;
    if (!textRef || (textRef.kind !== "text" && textRef.kind !== "artifact_revision")) {
      throw new AgentError("INVALID_INPUT", "冻结镜头缺少提示词。");
    }
    const prompt =
      textRef.kind === "text"
        ? textRef.text.trim()
        : markdownFullText(
            JSON.parse(
              (
                this.db
                  .prepare("SELECT content_json FROM artifact_revisions WHERE id=? AND artifact_id=?")
                  .get(textRef.revisionId, textRef.artifactId) as { content_json: string }
              ).content_json,
            ) as MarkdownContent,
          ).trim();
    if (!prompt) throw new AgentError("INVALID_INPUT", "镜头提示词不能为空。");

    const resolvedImg = input.resolvedInputs.find(x => x.slot === firstSlot.slot);
    if (!resolvedImg) throw new AgentError("INVALID_INPUT", "冻结首帧图尚未就绪。");
    const ownerId = runRow(this.db, input.runId).owner_id;
    const blob = this.blobs.get(ownerId, resolvedImg.blobId);
    const srcFile = this.blobs.filePath(blob.digest);
    const facts = await probeImageFile(srcFile);
    if (blob.digest !== resolvedImg.digest || facts.mimeType !== blob.mime_type) {
      throw new AgentError("INVALID_INPUT", "首帧图与冻结摘要不一致。");
    }

    const ext = facts.mimeType === "image/png" ? ".png" : facts.mimeType === "image/webp" ? ".webp" : ".jpg";
    const attemptDir = path.join(this.options.workRoot, input.attemptId);
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    const stagedFrame = path.join(attemptDir, `first_frame${ext}`);
    await copyFile(srcFile, stagedFrame);
    await writeFile(path.join(attemptDir, "prompt.txt"), prompt, { encoding: "utf8", mode: 0o600 });
    return { firstFrameFile: stagedFrame, prompt };
  }

  private async settleFromExecutorFile(
    query: ProviderRecoveryQuery,
    executorMp4Path: string,
    usage?: ProviderUsage,
    sampleReplay?: boolean,
  ): Promise<ExecutionObservation> {
    if (query.providerTaskId || usage) {
      this.db.transaction(() =>
        recordAttemptOutput(this.db, this.clock(), query.attemptId, {
          ...(query.providerTaskId ? { providerTaskId: query.providerTaskId } : {}),
          ...(usage ? { usage } : {}),
        }),
      )();
    }
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    const deterministicMp4 = path.join(attemptDir, "download.mp4");
    if (!existsSync(deterministicMp4)) {
      await mkdir(attemptDir, { recursive: true, mode: 0o700 });
      await copyFile(executorMp4Path, deterministicMp4);
    }
    return this.settleLocalDownload(query, usage, sampleReplay);
  }

  private async settleLocalDownload(
    query: ProviderRecoveryQuery,
    usage?: ProviderUsage,
    sampleReplay?: boolean,
  ): Promise<ExecutionObservation> {
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    const obs = await settleDownloadedVideo({
      db: this.db,
      blobs: this.blobs,
      observations: this.observations,
      attemptId: query.attemptId,
      runId: query.runId,
      operationId: query.operationId,
      providerTaskId: query.providerTaskId,
      attemptDir,
      finalFile: path.join(attemptDir, "download.mp4"),
      ...(usage ? { usage } : {}),
      validate: (facts, op) => colabOutputMismatch(facts, op.parameters),
      retryMessage: "Colab 成片已取回，本地媒体校验暂时未完成；保留已有文件稍后复核，不重复生成。",
    });
    const mergedUsage = completedUsage(this.db, query.attemptId).usage ?? usage;
    const withEvidence = this.withUsage(obs, mergedUsage);
    // 真实 Colab GPU 已运行任务绝不签发人民币 0 元权威结算，保持 billing: null（pending_reconciliation）并保留 CU 证据；
    // 仅测试显式注入的免额度本地样片回放从未触达外部服务，费用确定为 0。
    if (
      (withEvidence.state === "succeeded" || withEvidence.state === "failed") &&
      this.isSampleReplay(query.providerTaskId, mergedUsage, sampleReplay)
    ) {
      return withZeroCostBilling(withEvidence);
    }
    return withEvidence;
  }

  private isSampleReplay(
    providerTaskId: string | null | undefined,
    usage?: ProviderUsage,
    explicitFlag?: boolean,
  ): boolean {
    return Boolean(
      explicitFlag ||
        providerTaskId?.startsWith("colab:sample-replay:") ||
        usage?.cacheSource === "sample_replay",
    );
  }

  private withUsage(obs: ExecutionObservation, usage?: ProviderUsage): ExecutionObservation {
    return usage ? { ...obs, usage } : obs;
  }

  private invokeExecutor(args: string[], stdinSecret?: string): Promise<ExecutorResponse> {
    const timeoutMs = this.options.commandTimeoutMs ?? 120_000;
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, [this.executorPath, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Colab 执行器超时（>${timeoutMs}ms）`));
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        stdout += chunk;
      });
      child.stderr.on("data", chunk => {
        stderr += chunk;
      });
      child.on("error", err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", code => {
        clearTimeout(timer);
        const trimmedOut = stdout.trim();
        if (trimmedOut) {
          try {
            const parsed = JSON.parse(trimmedOut) as ExecutorResponse;
            resolve(parsed);
            return;
          } catch {
            // Fall through to stderr/exit check
          }
        }
        const trimmedErr = stderr.trim();
        if (trimmedErr) {
          try {
            const parsedErr = JSON.parse(trimmedErr) as ExecutorResponse;
            if (parsedErr.error || parsedErr.message) {
              reject(new Error(parsedErr.error ?? parsedErr.message));
              return;
            }
          } catch {
            // Plain text stderr
          }
        }
        reject(new Error(`Colab 执行器异常退出（exit ${code}）：${(trimmedErr || trimmedOut).slice(-400)}`));
      });

      if (stdinSecret) child.stdin.write(stdinSecret);
      child.stdin.end();
    });
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    return withZeroCostBilling(this.observations.deterministic(attemptId, "failed", null, message));
  }
}
