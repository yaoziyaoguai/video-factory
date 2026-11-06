import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, InputRef, MarkdownContent, ModelBinding, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { InvalidAudioFile, probeAudioFile, type AudioFileFacts } from "./media-probe.js";
import type { AgentClock } from "./util.js";
import type { MiniMaxSpeechProfile } from "./media-config.js";
import { getRevisionRow } from "./artifact-store.js";
import { PortObservations, ProviderHttpError, providerRequestJson } from "./media-port-support.js";
import { speechText } from "../../shared/agent/markdown.js";

// MiniMax t2a v2 同步配音薄适配（wire 序列按 2026-11-01 官方页核实）：
// POST /v1/t2a_v2 {model, text, stream:false, output_format:"hex", voice_setting:{voice_id},
// audio_setting:{sample_rate:32000, bitrate:128000, format:"mp3", channel:1}} →
// base_resp.status_code=0 + data.audio（hex MP3）+ extra_info.usage_characters（计费字符）。
// 成品按冻结规格验收（MP3/32kHz/单声道/≤120s）；usage_characters 只写观测消息，billing 恒 null。
// 单次请求没有可外查的任务身份：查询/取消只读本地收据与已落盘文件，缺证据稳定 unknown，不重发。

export type MiniMaxSpeechBindingResolver = (binding: ModelBinding) => { profile: MiniMaxSpeechProfile; apiKey: string | null } | null;

export interface MiniMaxSpeechPortOptions {
  resolve: MiniMaxSpeechBindingResolver;
  /** 尝试工作目录（确定性位置：<workRoot>/<attemptId>/speech.mp3）。 */
  workRoot: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
// t2a v2 固定输出规格（32kHz 单声道 MP3），与 MiniMaxSpeechProfile.speech.output 同源；
// 验收按协议规格常量执行，不依赖运行时状态。
const SAMPLE_RATE_HZ = 32_000;

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

class BadAudioOutput extends Error {}

export class MiniMaxSpeechPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly observations: PortObservations;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: MiniMaxSpeechPortOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.observations = new PortObservations(db, clock, "minimax-speech");
  }

  async submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "speech") throw new Error("MiniMax 配音通道只接受 speech 操作。");
    if (signal?.aborted) {
      return this.observations.deterministic(input.attemptId, "cancelled", null, "停止请求发生在请求发出之前；未提交任何请求。");
    }
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "配音凭据未启用；未提交任何请求，不会自动重试。");
    // 输入已经过能力校验（恰好一份旁白文本，prepare 已按码点判断一次）；原文直发，不改写、不截断。
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const text = ref.kind === "text" ? ref.text : speechText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const { speech } = resolved.profile;
    const apiKey = resolved.apiKey;
    let parsed: Record<string, unknown>;
    try {
      parsed = await providerRequestJson("POST", new URL(`${resolved.profile.baseUrl}/v1/t2a_v2`), apiKey, {
        model: resolved.profile.modelId,
        text,
        stream: false,
        output_format: "hex",
        voice_setting: { voice_id: speech.voice },
        audio_setting: {
          sample_rate: speech.output.sampleRateHz,
          bitrate: speech.output.bitrate,
          format: speech.output.format,
          channel: speech.output.channels,
        },
      }, { fetchImpl: this.fetchImpl, requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, signal });
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status >= 400 && error.status < 500 && error.status !== 408) {
        return this.preRefusal(input.attemptId, `供应商明确拒绝配音请求：${error.message}`);
      }
      // 超时、断连、5xx：无法证明未受理 → unknown，不自动重发。
      return this.observations.unstableUnknown(input.attemptId, null,
        `配音请求结果未核实（${error instanceof ProviderHttpError ? error.message : "网络请求或响应未完成"}）；保留原身份核对，不会重新提交。`);
    }
    // t2a v2 用 HTTP 200 + base_resp 表达业务拒绝：明确失败（未产出音频）不是未知。
    const baseResp = typeof parsed.base_resp === "object" && parsed.base_resp !== null ? parsed.base_resp as { status_code?: unknown } : {};
    if (baseResp.status_code !== 0) {
      return this.preRefusal(input.attemptId, `供应商明确拒绝配音请求（base_resp ${typeof baseResp.status_code === "number" ? baseResp.status_code : "?"}）。`);
    }
    const data = typeof parsed.data === "object" && parsed.data !== null ? parsed.data as { audio?: unknown } : {};
    if (typeof data.audio !== "string" || data.audio.length === 0) {
      return this.preRefusal(input.attemptId, "供应商未返回任何音频。");
    }
    if (!/^(?:[0-9a-fA-F]{2})+$/.test(data.audio)) {
      return this.observations.nonCompliant(input.attemptId, null, "供应商返回的音频不是完整合法的 hex 数据。");
    }
    const audio = Buffer.from(data.audio, "hex");
    const extra = typeof parsed.extra_info === "object" && parsed.extra_info !== null ? parsed.extra_info as { usage_characters?: unknown } : {};
    const usageCharacters = typeof extra.usage_characters === "number" ? extra.usage_characters : null;
    return this.settleBytes(input.attemptId, audio, usageCharacters);
  }

  // 单次请求没有可外查的任务身份：恢复只读本地证据，不要求当前 Key 可用。
  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.observations.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          return this.observations.deterministicSucceeded(query.attemptId, null, blob.id, blob.digest, "audio/mpeg",
            receipt.detail ?? "成品收据核对通过。");
        } catch { /* 成品文件缺失：继续按其余本地证据分支核对 */ }
      }
    }
    if (receipt?.exit_kind === "failed") {
      return this.observations.deterministic(query.attemptId, "failed", null, receipt.detail ?? "已取得的输出不满足冻结参数。");
    }
    if (existsSync(path.join(this.options.workRoot, query.attemptId, "speech.mp3"))) return this.settleSpeech(query.attemptId);
    return this.observations.stableUnknown(query.attemptId,
      "单次配音请求没有可查询的任务身份，无法向供应商查询；结果与实际费用未取得；不会重新提交。");
  }

  // 请求由 submit 内联完成；恢复路径与 query 相同，只核对已有文件与收据。
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  // —— 落盘与验收 ——

  /** 音频字节原子落盘→按冻结规格探测核对→发布；规格不符如实 failed，工具暂不可用保留文件 unknown。 */
  private async settleBytes(attemptId: string, audio: Buffer, usageCharacters: number | null): Promise<ExecutionObservation> {
    const attemptDir = path.join(this.options.workRoot, attemptId);
    const temporary = path.join(attemptDir, "speech.mp3.part");
    const finalFile = path.join(attemptDir, "speech.mp3");
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, audio, { mode: 0o600 });
    const handle = openSync(temporary, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    renameSync(temporary, finalFile);
    return this.settleSpeech(attemptId, usageCharacters);
  }

  /** 完整文件与 query 共用落点；存在不代表验收成功，探测通过后才发布。 */
  private async settleSpeech(attemptId: string, usageCharacters: number | null = null): Promise<ExecutionObservation> {
    const finalFile = path.join(this.options.workRoot, attemptId, "speech.mp3");
    try {
      const facts = await probeAudioFile(finalFile);
      this.verifyAudio(facts);
      return this.publish(attemptId, facts.durationMs, usageCharacters);
    } catch (error) {
      if (error instanceof InvalidAudioFile || error instanceof BadAudioOutput) {
        rmSync(finalFile, { force: true });
        return this.observations.nonCompliant(attemptId, null, error.message);
      }
      return this.observations.stableUnknown(attemptId,
        `音频文件已取得，本地校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留文件继续核对，不重新提交。`);
    }
  }

  private publish(attemptId: string, durationMs: number, usageCharacters: number | null): ExecutionObservation {
    const finalFile = path.join(this.options.workRoot, attemptId, "speech.mp3");
    const row = this.db.prepare("SELECT run_id FROM production_attempts WHERE id=?").get(attemptId) as { run_id: string };
    const run = runRow(this.db, row.run_id);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(finalFile), "audio/mpeg", durationMs);
    const detail = `音频 ${(durationMs / 1000).toFixed(1)} 秒`
      + (usageCharacters !== null ? `；计费字符 ${usageCharacters}，实际以供应商账单为准` : "");
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { blobId: blob.id, digest: blob.digest, detail }))();
    return this.observations.deterministicSucceeded(attemptId, null, blob.id, blob.digest, "audio/mpeg", detail);
  }

  // 音频验收规格是本通道版本的固定事实：MP3/32kHz/单声道/≤120s；不符不发布。
  private verifyAudio(facts: AudioFileFacts): void {
    if (facts.channels !== 1) throw new BadAudioOutput(`输出不是单声道（实际 ${facts.channels} 声道）。`);
    if (facts.sampleRate !== SAMPLE_RATE_HZ) {
      throw new BadAudioOutput(`输出采样率 ${facts.sampleRate}Hz 与冻结规格 ${SAMPLE_RATE_HZ}Hz 不符。`);
    }
    if (facts.durationMs > 120_000) throw new BadAudioOutput(`音频时长 ${(facts.durationMs / 1000).toFixed(1)}s 超过 120s 验收上限。`);
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    return this.observations.deterministic(attemptId, "failed", null, message);
  }
}
