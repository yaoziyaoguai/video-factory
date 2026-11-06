import { execFile } from "node:child_process";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, InputRef, MarkdownContent, ModelBinding, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { InvalidAudioFile, probeAudioFile, type AudioFileFacts } from "./media-probe.js";
import { digestOf, type AgentClock } from "./util.js";
import { getRevisionRow } from "./artifact-store.js";
import type { OpenAISpeechProfile } from "./media-config.js";
import { speechText } from "../../shared/agent/markdown.js";

// OpenAI Realtime 单次配音适配（B1/B2，wire 序列按 2026-10-31 真实调用证据）：
// wss <baseUrl>/realtime?model=<id>（Authorization 头）→ session.created → session.update（realtime、
// marin、audio/pcm 24k、max_output_tokens、reasoning effort）→ session.updated → conversation.item.create
// + response.create → 收集 output_audio.delta（base64 PCM16/24k/mono）与转写 delta → response.done 必须
// completed。PCM 经 FFmpeg 转 MP3（24kHz 单声道）后按冻结规格验收；转写与旁白只差空白/标点才算通过，
// 不符不发布 blob。billing 恒 null；实际用量写入观测消息。该接口没有可外查的任务身份：query/cancel
// 只读本地文件与收据，缺证据稳定 unknown。signal：未发出即停止 → cancelled；已生成后停止 → response.cancel。

const run = promisify(execFile);

/** 按冻结绑定解析该次调用的执行配置与原 Key；返回 null 表示绑定不在本部署历史（漂移）。 */
export type OpenAISpeechBindingResolver = (binding: ModelBinding) => { profile: OpenAISpeechProfile; apiKey: string | null } | null;

/** 受控传输接缝：默认包装 ws；测试注入本地替身。错误回传受控文本与可解析的 HTTP 状态，不外泄正文。 */
export interface RealtimeTransport {
  send(text: string): void;
  close(): void;
  terminate(): void;
  onMessage(listener: (text: string) => void): void;
  onError(listener: (message: string, httpStatus: number | null) => void): void;
  onClose(listener: () => void): void;
}

export type RealtimeTransportFactory = (url: string, authorization: string, handshakeTimeoutMs: number) => RealtimeTransport;

export interface OpenAISpeechPortOptions {
  resolve: OpenAISpeechBindingResolver;
  /** 尝试工作目录（确定性位置：<workRoot>/<attemptId>/narration.pcm、speech.mp3）。 */
  workRoot: string;
  transportFactory?: RealtimeTransportFactory;
  ffmpegPath?: string;
  sessionTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

const DEFAULT_SESSION_TIMEOUT_MS = 180_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const ENCODE_TIMEOUT_MS = 60_000;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
// PCM16/24kHz/mono：每秒 48000 字节；与 profile.speech 的冻结规格同源（类型字面量固定 24000/1）。
const SAMPLE_RATE_HZ = 24_000;
const CHANNELS = 1;
const PCM_BYTES_PER_SECOND = SAMPLE_RATE_HZ * 2 * CHANNELS;
const INSTRUCTIONS = "请用自然清晰的普通话，逐字朗读用户提供的文字，不添加任何解释或其他内容。";

type ProviderRecoveryQuery = Extract<RecoveryQuery, { kind: "provider" }>;

type SessionOutcome =
  | { kind: "rejection"; message: string }
  | { kind: "failed"; message: string }
  | { kind: "notSent"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "unknown"; message: string }
  | { kind: "audio"; pcm: Buffer; transcript: string; usage: { inputTokens: number; outputTokens: number } };

export class OpenAISpeechPort implements MediaExecutionPort {
  readonly reconcileTerminalBilling = false;
  readonly queryRequiresProviderTaskId = true;
  private readonly transportFactory: RealtimeTransportFactory;

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: OpenAISpeechPortOptions) {
    this.transportFactory = options.transportFactory ?? defaultTransportFactory;
  }

  async submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    if (input.operation.kind !== "speech") throw new Error("OpenAI 配音通道只接受 speech 操作。");
    if (signal?.aborted) return this.deterministic(input.attemptId, "cancelled", "停止请求发生在请求发出之前；未提交任何请求。");
    const resolved = this.options.resolve(input.operation.model);
    if (!resolved) return this.preRefusal(input.attemptId, "账号配置已变化，未使用当前账号提交请求。");
    if (!resolved.apiKey) return this.preRefusal(input.attemptId, "配音凭据未启用；未提交任何请求，不会自动重试。");
    // 输入已经过能力校验（恰好一份旁白文本，prepare 已按码点判断一次）；
    // 这里直接读取原文发送，不删标题、不改写、不截断，也不重复整份执行对象校验。
    const ref = input.operation.inputs[0] as Extract<InputRef, { kind: "text" | "artifact_revision" }>;
    const text = ref.kind === "text" ? ref.text : speechText(JSON.parse(getRevisionRow(this.db, ref.artifactId, ref.revisionId)!.content_json) as MarkdownContent);
    const outcome = await this.runSession(resolved.apiKey, text, resolved.profile, signal);
    if (outcome.kind === "rejection") return this.preRefusal(input.attemptId, `供应商明确拒绝创建配音：${outcome.message}`);
    if (outcome.kind === "failed") return this.nonCompliant(input.attemptId, outcome.message);
    // notSent：生成指令从未送达，无输出也无费用，按提交前失败记录（exitKind=failed，零请求事实留在 detail）。
    if (outcome.kind === "notSent") return this.preRefusal(input.attemptId, outcome.message);
    if (outcome.kind === "cancelled") return this.deterministic(input.attemptId, "cancelled", outcome.message);
    if (outcome.kind === "unknown") {
      return this.unstableUnknown(input.attemptId, `配音会话结果未核实（${outcome.message}）；保留原身份核对，不会重新提交。`);
    }
    if (outcome.pcm.length === 0) return this.nonCompliant(input.attemptId, "供应商未返回任何音频。");
    const durationMs = Math.round(outcome.pcm.length / PCM_BYTES_PER_SECOND * 1000);
    if (durationMs > resolved.profile.speech.maxDurationMs) {
      return this.nonCompliant(input.attemptId, `音频时长 ${(durationMs / 1000).toFixed(1)}s 超过本配置 120s 验收上限。`);
    }
    if (!transcriptMatches(outcome.transcript, text)) {
      return this.nonCompliant(input.attemptId, "内容未通过：供应商转写与旁白不一致，不发布该音频。");
    }
    return this.settleBytes(input.attemptId, outcome.pcm, outcome.usage);
  }

  // 单次会话没有可外查的任务身份：恢复只读本地证据，不要求当前 Key 可用。
  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    if (query.kind !== "provider") return this.stableUnknown(query.attemptId, "查询类型与通道不匹配。");
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      const run = runRow(this.db, query.runId);
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try {
          this.blobs.verify(blob);
          return this.deterministicSucceeded(query.attemptId, blob.id, blob.digest, receipt.detail ?? "成品收据核对通过");
        } catch { /* 成品文件缺失：继续按其余本地证据分支核对 */ }
      }
    }
    if (receipt?.exit_kind === "failed") {
      return this.deterministic(query.attemptId, "failed", receipt.detail ?? "已取得的输出不满足冻结参数。");
    }
    const attemptDir = path.join(this.options.workRoot, query.attemptId);
    if (existsSync(path.join(attemptDir, "speech.mp3"))) return this.settleSpeech(query.attemptId);
    return this.stableUnknown(query.attemptId, "单次配音会话没有可查询的任务身份，无法向供应商查询；结果与实际费用未取得；不会重新提交。");
  }

  // 会话由 submit 内联完成；恢复路径与 query 相同，只核对已有文件与收据。
  cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    return this.query(query);
  }

  // —— 会话状态机 ——

  private runSession(apiKey: string, text: string, profile: OpenAISpeechProfile, signal?: AbortSignal): Promise<SessionOutcome> {
    return new Promise<SessionOutcome>(resolve => {
      let settled = false;
      let sentResponse = false;
      let stopped = false;
      const chunks: Buffer[] = [];
      let transcript = "";
      const transport = this.transportFactory(realtimeUrl(profile), `Bearer ${apiKey}`, this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
      const finish = (outcome: SessionOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onStop);
        try { transport.close(); } catch { /* 已关闭 */ }
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        transport.terminate();
        finish({ kind: "unknown", message: "会话超过 180 秒截止" });
      }, this.options.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS);
      const onStop = (): void => {
        if (settled) return;
        stopped = true;
        // 请求已发出：尝试让远端停止生成，随后立即结束本地等待并清理连接——
        // 不依赖对端回执（收不到终态不再等满 180 秒截止）；此刻没有已知终态就如实落
        // “结果未确认”。取消指令发送失败同样走清理，不挂起。
        if (!sentResponse) { finish({ kind: "cancelled", message: "停止请求发生在请求发出之前；未提交任何请求。" }); return; }
        try { transport.send(JSON.stringify({ type: "response.cancel" })); } catch { /* 发送失败同样结束本地等待 */ }
        finish({ kind: "unknown", message: "本地已停止等待并请求远端停止，供应商侧结果与费用未确认。" });
      };
      signal?.addEventListener("abort", onStop, { once: true });
      transport.onError((message, httpStatus) => {
        // 握手期 4xx（鉴权/限流/型号无效）是明确未受理；其余传输错误一律无法证明未受理。
        if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
          finish({ kind: "rejection", message });
          return;
        }
        // response.create 未发出＝供应商没收到生成指令（与停止路径同一事实）；确定失败，不落 unknown。
        finish(sentResponse
          ? { kind: "unknown", message }
          : { kind: "notSent", message: `生成请求未发出（${message}）；供应商未收到任何生成指令。` });
      });
      transport.onClose(() => {
        if (settled) return;
        finish(sentResponse
          ? { kind: "unknown", message: "连接在响应完成前关闭" }
          : { kind: "notSent", message: "连接在请求发出前关闭；未提交生成请求。" });
      });
      transport.onMessage(raw => {
        if (settled) return;
        let event: Record<string, unknown>;
        try { event = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
        switch (event.type) {
          case "session.created":
            if (stopped) return;
            transport.send(JSON.stringify({
              type: "session.update",
              session: {
                type: "realtime", model: profile.modelId, instructions: INSTRUCTIONS,
                output_modalities: ["audio"], max_output_tokens: profile.speech.maxOutputTokens,
                reasoning: { effort: profile.speech.reasoningEffort },
                audio: { input: { turn_detection: null }, output: { format: { type: "audio/pcm", rate: profile.speech.output.sampleRateHz }, voice: profile.speech.voice } },
              },
            }));
            return;
          case "session.updated":
            if (stopped) return;
            transport.send(JSON.stringify({
              type: "conversation.item.create",
              item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
            }));
            transport.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"] } }));
            sentResponse = true;
            return;
          case "response.output_audio.delta": {
            if (typeof event.delta !== "string" || event.delta.length === 0) return;
            chunks.push(Buffer.from(event.delta, "base64"));
            if (chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) > MAX_AUDIO_BYTES) {
              transport.terminate();
              finish({ kind: "unknown", message: "音频流超过大小上限" });
            }
            return;
          }
          case "response.output_audio_transcript.delta":
            if (typeof event.delta === "string") transcript += event.delta;
            return;
          case "error": {
            // 供应商在会话内主动报告的错误是确定事实（如内容审查拒绝）。
            const detail = event.error as { type?: unknown } | undefined;
            finish({ kind: "rejection", message: `供应商会话错误${typeof detail?.type === "string" ? `（${detail.type}）` : ""}` });
            return;
          }
          case "response.done": {
            const response = event.response as { status?: unknown; usage?: unknown } | undefined;
            const usage = readUsage(response?.usage);
            if (response?.status === "completed") {
              finish({ kind: "audio", pcm: Buffer.concat(chunks), transcript, usage });
              return;
            }
            if (response?.status === "cancelled") {
              finish({ kind: "cancelled", message: stopped ? "本地停止后供应商已终止生成。" : "供应商已取消生成。" });
              return;
            }
            finish(typeof response?.status === "string"
              ? { kind: "failed", message: `供应商响应未完成（status=${response.status}）。` }
              : { kind: "unknown", message: "供应商响应缺少有效状态" });
            return;
          }
          default:
            return;
        }
      });
    });
  }

  // —— 落盘与验收 ——

  /** PCM 原始落盘→FFmpeg 转 MP3→探测按冻结规格核对→原子移入完成位置；产出不可用如实 failed，工具暂不可用保留文件 unknown。 */
  private async settleBytes(attemptId: string, pcm: Buffer, usage: { inputTokens: number; outputTokens: number }): Promise<ExecutionObservation> {
    const attemptDir = path.join(this.options.workRoot, attemptId);
    const pcmFile = path.join(attemptDir, "narration.pcm");
    const temporary = path.join(attemptDir, "speech.mp3.part");
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    writeFileSync(pcmFile, pcm, { mode: 0o600 });
    const handle = openSync(pcmFile, "r+");
    try { fsyncSync(handle); } finally { closeSync(handle); }
    let durationMs = 0;
    let encoded = false;
    try {
      await this.encodeMp3(pcmFile, temporary);
      encoded = true;
      const facts = await probeAudioFile(temporary);
      this.verifyAudio(facts);
      durationMs = facts.durationMs;
      renameSync(temporary, path.join(attemptDir, "speech.mp3"));
    } catch (error) {
      // 编码阶段：可执行文件缺失或超时是本地工具不可用；其余退出失败是这批 PCM 的确定转码失败。
      if (!encoded && encodeFailureKind(error) === "output") {
        rmSync(temporary, { force: true });
        rmSync(pcmFile, { force: true });
        return this.nonCompliant(attemptId, `PCM 音频无法转码为 MP3：${error instanceof Error ? error.message : String(error)}`);
      }
      if (error instanceof InvalidAudioFile || error instanceof BadAudioOutput) {
        rmSync(temporary, { force: true });
        rmSync(pcmFile, { force: true });
        return this.nonCompliant(attemptId, error.message);
      }
      return this.unstableUnknown(attemptId,
        `音频已取得，本地转码或校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留原始文件继续核对，不重新提交。`);
    }
    rmSync(pcmFile, { force: true });
    return this.publish(attemptId, durationMs, usage);
  }

  /** 完成文件已就位但收据缺失（落盘与登记之间中断）：按冻结规格重验后补收据，只发布一次。 */
  private async settleSpeech(attemptId: string): Promise<ExecutionObservation> {
    const finalFile = path.join(this.options.workRoot, attemptId, "speech.mp3");
    try {
      const facts = await probeAudioFile(finalFile);
      this.verifyAudio(facts);
      return this.publish(attemptId, facts.durationMs, null);
    } catch (error) {
      if (error instanceof InvalidAudioFile || error instanceof BadAudioOutput) {
        // 恢复同样不放过规格不符文件：登记失败收据，不发布。
        rmSync(finalFile, { force: true });
        return this.nonCompliant(attemptId, error.message);
      }
      return this.stableUnknown(attemptId,
        `音频文件已取得，本地校验暂不可用（${error instanceof Error ? error.message : String(error)}）；保留文件继续核对，不重新提交。`);
    }
  }

  private publish(attemptId: string, durationMs: number, usage: { inputTokens: number; outputTokens: number } | null): ExecutionObservation {
    const finalFile = path.join(this.options.workRoot, attemptId, "speech.mp3");
    const row = this.db.prepare("SELECT run_id FROM production_attempts WHERE id=?").get(attemptId) as { run_id: string };
    const run = runRow(this.db, row.run_id);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(finalFile), "audio/mpeg", durationMs);
    const detail = `音频 ${(durationMs / 1000).toFixed(1)} 秒`
      + (usage ? `；实际用量：输入 ${usage.inputTokens} / 输出 ${usage.outputTokens} token，计费以供应商账单为准` : "");
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { blobId: blob.id, digest: blob.digest, detail }))();
    return this.deterministicSucceeded(attemptId, blob.id, blob.digest, detail);
  }

  // 音频验收规格是本通道版本的固定事实（B1），不含操作参数派生项；>120s 如实 failed、费用待核。
  private verifyAudio(facts: AudioFileFacts): void {
    if (facts.channels !== CHANNELS) throw new BadAudioOutput(`输出不是单声道（实际 ${facts.channels} 声道）。`);
    if (facts.sampleRate !== SAMPLE_RATE_HZ) {
      throw new BadAudioOutput(`输出采样率 ${facts.sampleRate}Hz 与冻结规格 ${SAMPLE_RATE_HZ}Hz 不符。`);
    }
    if (facts.durationMs <= 0) throw new BadAudioOutput("输出时长为零。");
    if (facts.durationMs > 120_000) {
      throw new BadAudioOutput(`输出时长 ${(facts.durationMs / 1000).toFixed(1)}s 超过本配置 120s 验收上限。`);
    }
  }

  private async encodeMp3(pcmFile: string, outputFile: string): Promise<void> {
    await run(this.options.ffmpegPath ?? "ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "s16le", "-ar", String(SAMPLE_RATE_HZ), "-ac", String(CHANNELS), "-i", pcmFile,
      "-codec:a", "libmp3lame", "-ar", String(SAMPLE_RATE_HZ), "-ac", String(CHANNELS), "-b:a", "128k",
      "-f", "mp3", "-y", outputFile,
    ], { timeout: ENCODE_TIMEOUT_MS });
  }

  // 完整响应已取得但确定不可用：failed 终态、登记效果收据、费用仍未核实，不再获取同一响应。
  private nonCompliant(attemptId: string, reason: string): ExecutionObservation {
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId,
      { exitKind: "failed", detail: `已完整取得的输出不满足冻结参数：${reason}` }))();
    return this.deterministic(attemptId, "failed", `已完整取得的输出不满足冻结参数：${reason}；费用待核。`);
  }

  private preRefusal(attemptId: string, message: string): ExecutionObservation {
    // B2：提交前本地拒绝/明确供应商拒绝同样登记效果收据，费用未发生的事实留在 detail。
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { exitKind: "failed", detail: message }))();
    return this.deterministic(attemptId, "failed", message);
  }

  private deterministic(attemptId: string, state: "failed" | "cancelled", message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-speech", state, message }).slice(0, 24)}`,
      attemptId, state, providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  private deterministicSucceeded(attemptId: string, blobId: string, digest: string, detail: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-speech", state: "succeeded", blobId }).slice(0, 24)}`,
      attemptId, state: "succeeded", providerTaskId: null, blob: { id: blobId, digest, mimeType: "audio/mpeg" },
      observedAt: this.stableTime(attemptId), message: `供应商配音已解码并核对通过（${detail}）。`, billing: null,
    };
  }

  // 稳定未知：同一 attempt 每次查询得到同一条观测，不生成新事实。
  private stableUnknown(attemptId: string, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-speech-unknown", message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId), message, billing: null,
    };
  }

  private unstableUnknown(attemptId: string, message: string): ExecutionObservation {
    return {
      observationId: `obs-${digestOf({ attemptId, scope: "openai-speech-transient", at: this.clock(), message }).slice(0, 24)}`,
      attemptId, state: "unknown", providerTaskId: null, blob: null, observedAt: this.clock(), message, billing: null,
    };
  }

  private stableTime(attemptId: string): string {
    const row = this.db.prepare("SELECT r.created_at AS at FROM production_runs r JOIN production_attempts a ON a.run_id=r.id WHERE a.id=?").get(attemptId) as { at: string } | undefined;
    return row?.at ?? this.clock();
  }
}

class BadAudioOutput extends Error {}

/** FFmpeg 可执行文件缺失（ENOENT）或被超时杀死是工具不可用；其余退出失败是这批 PCM 的确定转码失败。 */
function encodeFailureKind(error: unknown): "tool" | "output" {
  if ((error as { code?: unknown } | null | undefined)?.code === "ENOENT") return "tool";
  if ((error as { killed?: unknown } | null | undefined)?.killed === true) return "tool";
  return "output";
}

function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  const usage = raw as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
  return {
    inputTokens: typeof usage?.input_tokens === "number" ? usage.input_tokens : 0,
    outputTokens: typeof usage?.output_tokens === "number" ? usage.output_tokens : 0,
  };
}

/** 转写与旁白只忽略空白与标点后逐字符比对；其余任何差异都算内容不符。 */
export function transcriptMatches(transcript: string, narration: string): boolean {
  const normalize = (value: string): string => value.replace(/[\s\p{P}]/gu, "");
  return normalize(transcript) === normalize(narration);
}

function realtimeUrl(profile: OpenAISpeechProfile): string {
  // 保留 baseUrl 版本前缀（如 https://api.openai.com/v1）；测试本地替身用 http:// 回落 ws://。
  const url = new URL(`${profile.baseUrl.replace(/\/+$/, "")}/realtime`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("model", profile.modelId);
  return url.toString();
}

// ws 库不读 HTTP(S)_PROXY（undici 的 env 代理只覆盖 fetch）；企业代理环境直连 wss 会握手超时。
// 仅对 wss 目标按 env 建 CONNECT 隧道；NO_PROXY 命中的主机（本地替身）保持直连。
function wssProxyAgent(target: string): { agent?: unknown } {
  if (!target.startsWith("wss:")) return {};
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return {};
  const hostname = new URL(target).hostname.toLowerCase();
  const excluded = (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
    .split(",").map(entry => entry.trim().toLowerCase()).filter(Boolean)
    .some(entry => hostname === entry || hostname.endsWith(entry.startsWith(".") ? entry : `.${entry}`));
  if (excluded) return {};
  const { HttpsProxyAgent } = createRequire(import.meta.url)("https-proxy-agent") as
    { HttpsProxyAgent: new (proxy: string) => unknown };
  return { agent: new HttpsProxyAgent(proxy) };
}

// ws 默认传输：Authorization 只进握手头；错误文本只保留受控消息与可解析的 HTTP 状态。
// require 边界隔离 @types/ws 的 export= 类型（本包是 ESM，无 esModuleInterop）。
interface WsClient {
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

function defaultTransportFactory(url: string, authorization: string, handshakeTimeoutMs: number): RealtimeTransport {
  const { WebSocket } = createRequire(import.meta.url)("ws") as
    { WebSocket: new (url: string, options: { headers: Record<string, string>; handshakeTimeout: number; agent?: unknown }) => WsClient };
  const socket = new WebSocket(url, { headers: { Authorization: authorization }, handshakeTimeout: handshakeTimeoutMs, ...wssProxyAgent(url) });
  return {
    // 关闭后的 send 失败由随后的 close/error 事件归入对应结局，这里不再抛出。
    send: text => { try { socket.send(text); } catch { /* 已关闭 */ } },
    close: () => { try { socket.close(); } catch { /* 已关闭 */ } },
    terminate: () => socket.terminate(),
    onMessage: listener => socket.on("message", (data: unknown) => listener(String(data))),
    onError: listener => socket.on("error", (error: Error) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message);
      listener(status ? `HTTP ${status[1]}` : "连接错误", status ? Number(status[1]) : null);
    }),
    onClose: listener => socket.on("close", () => listener()),
  };
}
