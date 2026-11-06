import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { MediaExecutionPort, SubmitPermit } from "../../shared/agent/ports.js";
import type { ExecutionInput, ExecutionObservation, RecoveryQuery } from "../../shared/agent/generated/contracts.js";
import type { AgentDatabase } from "./db.js";
import type { ProductionBlobs } from "./production-blobs.js";
import { consumeSubmitPermit } from "./submit-permit.js";
import { attemptOutput, recordAttemptOutput, runRow } from "./production-store.js";
import { InvalidVideoFile, probeAudioFile, probeImageFile, probeVideoFile, type VideoFileFacts } from "./media-probe.js";
import { digestOf, type AgentClock } from "./util.js";
import type { RenderParameters } from "../../shared/agent/generated/contracts.js";

// 真实本地 ordered_concat：受控 argv 调 FFmpeg，按输入原顺序机械归一为冻结输出规格。
// submit 在后台异步等待子进程退出（占用 worker 本地并发名额）；先原子落盘再写效果收据。
// 退出/成品收据缺失即视为没有退出证据：保持 unknown 并跨重启保留本地占用，不自动重新渲染。

export interface LocalRenderOptions {
  /** 尝试工作目录（确定性位置：<workRoot>/<attemptId>/output.mp4）。 */
  workRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** 单次拼接的最长执行时间；超时终止并记 failed 收据。 */
  timeoutMs?: number;
}

interface TrackedChild { child: ChildProcess; done: Promise<void> }

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const run = promisify(execFile);

// 装配时核实本地渲染能力：ffmpeg/ffprobe 可执行且 ffmpeg 带 libx264（ordered_concat）；
// AAC 编码器只影响 T6 narrated_concat 有声分支，缺失不阻断无声拼接。
export async function localRenderAvailability(
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
): Promise<{ available: boolean; probeAvailable: boolean; aacAvailable: boolean; reason: string }> {
  try {
    await run(ffprobePath, ["-version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    return { available: false, probeAvailable: false, aacAvailable: false, reason: `未找到可执行的 ffprobe（${ffprobePath}），本地拼接未启用。` };
  }
  try {
    const { stdout } = await run(ffmpegPath, ["-hide_banner", "-encoders"], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    if (!/(^|\s)libx264(?=\s|$)/m.test(stdout)) return { available: false, probeAvailable: true, aacAvailable: false, reason: "ffmpeg 缺少 libx264 编码器，本地拼接未启用。" };
    if (!/(^|\s)aac(?=\s|$)/m.test(stdout)) return { available: true, probeAvailable: true, aacAvailable: false, reason: "ffmpeg 缺少 AAC 编码器，有声拼接未启用。" };
  } catch {
    return { available: false, probeAvailable: true, aacAvailable: false, reason: `未找到可执行的 ffmpeg（${ffmpegPath}），本地拼接未启用。` };
  }
  return { available: true, probeAvailable: true, aacAvailable: true, reason: "ffmpeg/ffprobe/libx264 已核实。" };
}

export class LocalRenderPort implements MediaExecutionPort {
  private readonly tracked = new Map<string, TrackedChild>();

  constructor(private readonly db: AgentDatabase, private readonly blobs: ProductionBlobs,
    private readonly clock: AgentClock, private readonly options: LocalRenderOptions) {}

  async submit(input: ExecutionInput, permit: SubmitPermit, signal?: AbortSignal): Promise<ExecutionObservation> {
    consumeSubmitPermit(permit, input.attemptId);
    const run = runRow(this.db, input.runId);
    if (input.operation.kind !== "render") throw new Error("本地端口只接受 render 操作。");
    const parameters = input.operation.parameters;
    if (parameters.assembly === "narrated_concat") return this.submitNarrated(input, run, parameters, signal);
    if (parameters.assembly === "timed_narrated_concat") return this.submitTimed(input, run, parameters, signal);
    if (parameters.assembly === "mixed_concat") return this.submitMixed(input, run, parameters, signal);
    const filesBySlot = new Map<number, { path: string; facts: VideoFileFacts }>();
    const filesByDigest = new Map<string, { path: string; facts: VideoFileFacts }>();
    for (const resolved of input.resolvedInputs) {
      let file = filesByDigest.get(resolved.digest);
      if (!file) {
        const filePath = this.blobs.filePath(resolved.digest);
        let facts: VideoFileFacts;
        try { facts = await probeVideoFile(filePath, this.options.ffprobePath); }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `渲染输入文件不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        file = { path: filePath, facts };
        filesByDigest.set(resolved.digest, file);
      }
      filesBySlot.set(resolved.slot, file);
    }
    // 输入按 OperationSpec.inputs 的数组顺序进入 ffmpeg；不排序、不去重，[A,B,A] 保留三段。
    const ordered = input.operation.inputs.map((_, slot) => filesBySlot.get(slot)!);
    // 省略 audioMode 保持历史行为：输出无声（有声输入整条去原声）；preserve 按画面时段保留原声、无声段补等长静音。
    const preserveAudio = (parameters.audioMode ?? "none") === "preserve";
    const attemptDir = path.join(this.options.workRoot, input.attemptId);
    const temporary = path.join(attemptDir, "output.part");
    const finalFile = path.join(attemptDir, "output.mp4");
    const filter = ordered
      .map((_, index) => `[${index}:v]setpts=PTS-STARTPTS,scale=${parameters.width}:${parameters.height},fps=${parameters.fps},setsar=1[v${index}]`)
      .concat([`${ordered.map((_, index) => `[v${index}]`).join("")}concat=n=${ordered.length}:v=1:a=0[out]`]);
    if (preserveAudio) {
      // 每段声音对齐自己的画面：短音轨补静音、长音轨裁齐；不能独立 concat 后让下一镜声音提前。
      ordered.forEach((file, index) => {
        const seconds = (file.facts.videoDurationMs / 1000).toFixed(3);
        filter.push(file.facts.hasAudio
          ? `[${index}:a]asetpts=PTS-STARTPTS,aresample=32000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${seconds},atrim=duration=${seconds}[a${index}]`
          : `anullsrc=r=32000:cl=mono:d=${seconds},aformat=sample_fmts=fltp:channel_layouts=mono[a${index}]`);
      });
      filter.push(`${ordered.map((_, index) => `[a${index}]`).join("")}concat=n=${ordered.length}:v=0:a=1[aout]`);
    }
    const args = ["-y", "-hide_banner", "-loglevel", "error",
      ...ordered.map(file => ["-i", file.path]).flat(),
      "-filter_complex", filter.join(";"), "-map", "[out]",
      ...(preserveAudio ? ["-map", "[aout]", "-c:a", "aac", "-ar", "32000", "-ac", "1"] : ["-an"]),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", temporary];
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
    const outcome = await this.runFfmpeg(input.attemptId, args, signal);
    if (outcome.kind !== "completed") {
      return this.terminal(input.attemptId, outcome.kind === "terminated" ? "cancelled" : "failed", outcome.detail ?? "本地渲染进程未成功结束。");
    }
    // 成品先校验再原子落盘：dims/fps 必须等于冻结输出规格，音轨按 audioMode 核对；时长按输入总和加容差。
    let outputFacts: VideoFileFacts;
    try { outputFacts = await probeVideoFile(temporary, this.options.ffprobePath); }
    catch (error) {
      return this.terminal(input.attemptId, "failed", `拼接输出不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    if (outputFacts.width !== parameters.width || outputFacts.height !== parameters.height || outputFacts.frameRate !== parameters.fps || outputFacts.hasAudio !== preserveAudio) {
      return this.terminal(input.attemptId, "failed",
        `拼接输出规格不符（${outputFacts.width}x${outputFacts.height}${outputFacts.hasAudio ? " 含声音轨" : " 无声音轨"}，要求 ${parameters.width}x${parameters.height}${preserveAudio ? " 保留原声" : " 无声"}）。`);
    }
    const expectedMs = ordered.reduce((sum, file) => sum + file.facts.videoDurationMs, 0);
    // 帧间隔容差；preserve 再加音频帧容差（与 narrated 分支同口径）。
    const toleranceMs = Math.ceil(((ordered.length + 1) * 1000) / parameters.fps) + (preserveAudio ? 40 : 0);
    if (Math.abs(outputFacts.durationMs - expectedMs) > toleranceMs) {
      return this.terminal(input.attemptId, "failed",
        `拼接输出时长 ${outputFacts.durationMs} ms 与输入总和 ${expectedMs} ms 不符。`);
    }
    renameSync(temporary, finalFile);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id,
      readFileSync(finalFile), "video/mp4", outputFacts.durationMs);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId,
      { blobId: blob.id, digest: blob.digest, exitKind: "completed" }))();
    return this.succeeded(input.attemptId, blob.id, blob.digest);
  }

  // §10 narrated_concat：画面按冻结顺序连接（保比例 pad 到 1280×720，原声一律丢弃），
  // 旁白从 0 播到尾不变速；成片=max(画面总时长,旁白时长)——画面短则停留尾帧，旁白短则补静音。
  private async submitNarrated(input: ExecutionInput, run: ReturnType<typeof runRow>,
    parameters: Extract<RenderParameters, { assembly: "narrated_concat" }>, signal?: AbortSignal): Promise<ExecutionObservation> {
    const byDigest = new Map<string, { path: string; facts: VideoFileFacts }>();
    const videosBySlot = new Map<number, { path: string; facts: VideoFileFacts }>();
    let narration: { path: string; durationMs: number } | null = null;
    for (const resolved of input.resolvedInputs) {
      if (resolved.slot === parameters.narrationInputSlot) {
        const filePath = this.blobs.filePath(resolved.digest);
        try { narration = { path: filePath, durationMs: (await probeAudioFile(filePath)).durationMs }; }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `旁白输入不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        continue;
      }
      let file = byDigest.get(resolved.digest);
      if (!file) {
        const filePath = this.blobs.filePath(resolved.digest);
        try { file = { path: filePath, facts: await probeVideoFile(filePath, this.options.ffprobePath) }; }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `视频画面输入不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        byDigest.set(resolved.digest, file);
      }
      videosBySlot.set(resolved.slot, file);
    }
    const ordered = parameters.videoInputSlots.map(slot => videosBySlot.get(slot)!);
    const videoTotalMs = ordered.reduce((sum, file) => sum + file.facts.videoDurationMs, 0);
    const targetMs = Math.max(videoTotalMs, narration!.durationMs);
    // 上游生成结果现在才有真实时长；prepare 的冻结能力上界不能代替这次文件事实。
    if (targetMs > 120_000) {
      return this.terminal(input.attemptId, "failed", "实际画面或旁白超过本配置 120s 上限；未裁剪，也未生成有声成片。");
    }
    const targetSeconds = targetMs / 1000;
    const videoPadSeconds = Math.max(0, (targetMs - videoTotalMs) / 1000);
    // 画面：保比例缩放并 pad（不拉伸竖画面），连接后按需停留尾帧；旁白：统一 32kHz 单声道并按需补静音。
    const filter = ordered
      .map((_, index) => `[${index}:v]scale=${parameters.width}:${parameters.height}:force_original_aspect_ratio=decrease,pad=${parameters.width}:${parameters.height}:(ow-iw)/2:(oh-ih)/2,fps=${parameters.fps},setsar=1[v${index}]`)
      .concat([
        `${ordered.map((_, index) => `[v${index}]`).join("")}concat=n=${ordered.length}:v=1:a=0[vcat]`,
        `[vcat]tpad=stop_mode=clone:stop_duration=${videoPadSeconds}[vout]`,
        `[${ordered.length}:a]aresample=32000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${targetSeconds}[aout]`,
      ]).join(";");
    const attemptDir = path.join(this.options.workRoot, input.attemptId);
    const temporary = path.join(attemptDir, "output.part");
    const finalFile = path.join(attemptDir, "output.mp4");
    const args = ["-y", "-hide_banner", "-loglevel", "error",
      ...ordered.map(file => ["-i", file.path]).flat(), "-i", narration!.path,
      "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "32000", "-ac", "1",
      "-movflags", "+faststart", "-t", String(targetSeconds), "-f", "mp4", temporary];
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
    const outcome = await this.runFfmpeg(input.attemptId, args, signal);
    if (outcome.kind !== "completed") {
      return this.terminal(input.attemptId, outcome.kind === "terminated" ? "cancelled" : "failed", outcome.detail ?? "本地渲染进程未成功结束。");
    }
    // 成品先校验再原子落盘：规格必须等于冻结输出，必须带真实旁白音轨；时长按画面/旁白上限加帧间隔与音频帧容差。
    let outputFacts: VideoFileFacts;
    try { outputFacts = await probeVideoFile(temporary, this.options.ffprobePath); }
    catch (error) {
      return this.terminal(input.attemptId, "failed", `有声拼接输出不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    if (outputFacts.width !== parameters.width || outputFacts.height !== parameters.height || outputFacts.frameRate !== parameters.fps || !outputFacts.hasAudio) {
      return this.terminal(input.attemptId, "failed",
        `有声拼接输出规格不符（${outputFacts.width}x${outputFacts.height}${outputFacts.hasAudio ? "" : " 无声音轨"}，要求 ${parameters.width}x${parameters.height} 含旁白音轨）。`);
    }
    const toleranceMs = Math.ceil(((ordered.length + 1) * 1000) / parameters.fps) + 40;
    if (Math.abs(outputFacts.durationMs - targetMs) > toleranceMs) {
      return this.terminal(input.attemptId, "failed",
        `有声拼接输出时长 ${outputFacts.durationMs} ms 与画面/旁白上限 ${targetMs} ms 不符。`);
    }
    renameSync(temporary, finalFile);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id,
      readFileSync(finalFile), "video/mp4", outputFacts.durationMs);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId,
      { blobId: blob.id, digest: blob.digest, exitKind: "completed" }))();
    return this.succeeded(input.attemptId, blob.id, blob.digest);
  }
  // S3-04 timed_narrated_concat：按冻结 segments 顺序裁切视频/停留图片，统一为冻结规格后连接；
  // 原声一律丢弃，旁白从 0 播放并按需补静音；成片时长取 segments.durationMs 之和。
  // 旁白实际长过画面总长时如实失败，不加速、不剪词、不延长画面。
  private async submitTimed(input: ExecutionInput, run: ReturnType<typeof runRow>,
    parameters: Extract<RenderParameters, { assembly: "timed_narrated_concat" }>, signal?: AbortSignal): Promise<ExecutionObservation> {
    const files = new Map<number, { index: number; path: string; kind: "video" | "image"; facts?: VideoFileFacts }>();
    let narration: { index: number; path: string; durationMs: number } | null = null;
    const inputArgs: string[][] = [];
    for (const resolved of input.resolvedInputs) {
      if (resolved.slot === parameters.narrationInputSlot) {
        if (narration) continue;
        const filePath = this.blobs.filePath(resolved.digest);
        let durationMs: number;
        try { durationMs = (await probeAudioFile(filePath)).durationMs; }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `旁白输入不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        narration = { index: inputArgs.length, path: filePath, durationMs };
        inputArgs.push(["-i", filePath]);
        continue;
      }
      if (files.has(resolved.slot)) continue;
      const filePath = this.blobs.filePath(resolved.digest);
      const segment = parameters.segments.find(item => item.inputSlot === resolved.slot);
      if (!segment) continue;
      const index = inputArgs.length;
      if (segment.kind === "image") {
        try { await probeImageFile(filePath); }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `图片片段不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        // 静帧按片段时长循环，来源原声不存在，无需额外丢弃。
        files.set(resolved.slot, { index, path: filePath, kind: "image" });
        inputArgs.push(["-loop", "1", "-i", filePath]);
      } else {
        let facts: VideoFileFacts;
        try { facts = await probeVideoFile(filePath, this.options.ffprobePath); }
        catch (error) {
          return this.terminal(input.attemptId, "failed", `视频片段不可读：${error instanceof Error ? error.message : String(error)}`);
        }
        files.set(resolved.slot, { index, path: filePath, kind: "video", facts });
        inputArgs.push(["-i", filePath]);
      }
    }
    const targetMs = parameters.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    if (!narration) return this.terminal(input.attemptId, "failed", "缺少旁白输入，未生成成片。");
    // 已付费配音的真实长度只有产出后才能知道；超长时保留音频与费用事实，不自动再生成。
    if (narration.durationMs > targetMs) {
      return this.terminal(input.attemptId, "failed",
        `旁白约 ${(narration.durationMs / 1000).toFixed(1)}s，超过画面总长 ${(targetMs / 1000).toFixed(1)}s；本策略不加速、不剪词、不延长画面，请修改方案后重新准备。`);
    }
    const segmentFilters: string[] = [];
    parameters.segments.forEach((segment, order) => {
      const file = files.get(segment.inputSlot);
      if (!file) throw new Error("片段输入缺失。");
      if (segment.kind === "video" && file.facts && file.facts.videoDurationMs < segment.startMs + segment.durationMs) {
        throw new Error("片段裁切范围超出源视频时长。");
      }
      const trim = segment.kind === "video"
        ? `trim=start=${(segment.startMs / 1000).toFixed(3)}:duration=${(segment.durationMs / 1000).toFixed(3)},setpts=PTS-STARTPTS`
        : `trim=duration=${(segment.durationMs / 1000).toFixed(3)},setpts=PTS-STARTPTS`;
      segmentFilters.push(`[${file.index}:v]${trim},scale=${parameters.width}:${parameters.height}:force_original_aspect_ratio=decrease,pad=${parameters.width}:${parameters.height}:(ow-iw)/2:(oh-ih)/2,fps=${parameters.fps},setsar=1[s${order}]`);
    });
    const targetSeconds = targetMs / 1000;
    const filter = segmentFilters.concat([
      `${parameters.segments.map((_, order) => `[s${order}]`).join("")}concat=n=${parameters.segments.length}:v=1:a=0[vout]`,
      `[${narration.index}:a]aresample=32000,aformat=sample_fmts=fltp:channel_layouts=mono,apad=whole_dur=${targetSeconds}[aout]`,
    ]).join(";");
    const attemptDir = path.join(this.options.workRoot, input.attemptId);
    const temporary = path.join(attemptDir, "output.part");
    const finalFile = path.join(attemptDir, "output.mp4");
    const args = ["-y", "-hide_banner", "-loglevel", "error",
      ...inputArgs.flat(),
      "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "32000", "-ac", "1",
      "-movflags", "+faststart", "-t", String(targetSeconds), "-f", "mp4", temporary];
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
    const outcome = await this.runFfmpeg(input.attemptId, args, signal);
    if (outcome.kind !== "completed") {
      return this.terminal(input.attemptId, outcome.kind === "terminated" ? "cancelled" : "failed", outcome.detail ?? "本地渲染进程未成功结束。");
    }
    let outputFacts: VideoFileFacts;
    try { outputFacts = await probeVideoFile(temporary, this.options.ffprobePath); }
    catch (error) {
      return this.terminal(input.attemptId, "failed", `剪辑输出不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    if (outputFacts.width !== parameters.width || outputFacts.height !== parameters.height || outputFacts.frameRate !== parameters.fps || !outputFacts.hasAudio) {
      return this.terminal(input.attemptId, "failed",
        `剪辑输出规格不符（${outputFacts.width}x${outputFacts.height}${outputFacts.hasAudio ? "" : " 无旁白音轨"}，要求 ${parameters.width}x${parameters.height} 含旁白音轨）。`);
    }
    const toleranceMs = Math.ceil(((parameters.segments.length + 1) * 1000) / parameters.fps) + 40;
    if (Math.abs(outputFacts.durationMs - targetMs) > toleranceMs) {
      return this.terminal(input.attemptId, "failed",
        `剪辑输出时长 ${outputFacts.durationMs} ms 与片段总长 ${targetMs} ms 不符。`);
    }
    renameSync(temporary, finalFile);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id,
      readFileSync(finalFile), "video/mp4", outputFacts.durationMs);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId,
      { blobId: blob.id, digest: blob.digest, exitKind: "completed" }))();
    return this.succeeded(input.attemptId, blob.id, blob.digest);
  }

  // M2：视觉时序、逐段原声、音乐选区与完整独立配音共同冻结；只让独立配音控制音乐避让。
  private async submitMixed(input: ExecutionInput, run: ReturnType<typeof runRow>,
    parameters: Extract<RenderParameters, { assembly: "mixed_concat" }>, signal?: AbortSignal): Promise<ExecutionObservation> {
    if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
    const files = new Map<number, { index: number; facts?: VideoFileFacts }>();
    let music: { index: number; durationMs: number } | null = null;
    let narration: { index: number; durationMs: number } | null = null;
    const inputArgs: string[][] = [];
    for (const resolved of input.resolvedInputs) {
      const filePath = this.blobs.filePath(resolved.digest);
      const index = inputArgs.length;
      let role = "画面";
      try {
        if (resolved.slot === parameters.music?.inputSlot || resolved.slot === parameters.narration?.inputSlot) {
          role = resolved.slot === parameters.music?.inputSlot ? "音乐" : "旁白";
          const file = { index, durationMs: (await probeAudioFile(filePath, signal)).durationMs };
          if (resolved.slot === parameters.music?.inputSlot) music = file;
          else narration = file;
          inputArgs.push(["-i", filePath]);
        } else {
          const segment = parameters.segments.find(item => item.inputSlot === resolved.slot);
          if (!segment || files.has(resolved.slot)) continue;
          if (segment.kind === "image") {
            role = "图片片段";
            await probeImageFile(filePath, signal);
            files.set(resolved.slot, { index });
            inputArgs.push(["-loop", "1", "-i", filePath]);
          } else {
            role = "视频片段";
            files.set(resolved.slot, { index, facts: await probeVideoFile(filePath, this.options.ffprobePath, signal) });
            inputArgs.push(["-i", filePath]);
          }
        }
      } catch (error) {
        if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
        return this.terminal(input.attemptId, "failed", `${role}输入不可读：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const targetMs = parameters.segments.reduce((sum, segment) => sum + segment.durationMs, 0);
    if (parameters.music && !music) return this.terminal(input.attemptId, "failed", "缺少指定音乐输入，未生成成片。");
    if (parameters.narration && !narration) return this.terminal(input.attemptId, "failed", "缺少指定旁白输入，未生成成片。");
    if (narration && parameters.narration && parameters.narration.timelineStartMs + narration.durationMs > targetMs) {
      return this.terminal(input.attemptId, "failed",
        `旁白约 ${(narration.durationMs / 1000).toFixed(1)}s，加起播位置后超过画面总长 ${(targetMs / 1000).toFixed(1)}s；本策略不加速、不剪词、不延长画面，已成功的配音保留供修改方案后复用。`);
    }
    if (music && parameters.music && parameters.music.sourceStartMs + parameters.music.sourceDurationMs > music.durationMs) {
      return this.terminal(input.attemptId, "failed", "音乐选区超出实际音频时长，未循环或补造音乐。");
    }
    const targetSeconds = targetMs / 1000;
    const filter: string[] = [];
    for (const [order, segment] of parameters.segments.entries()) {
      const file = files.get(segment.inputSlot);
      if (!file) return this.terminal(input.attemptId, "failed", "缺少画面片段输入，未生成成片。");
      if (segment.kind === "video" && file.facts && segment.startMs + segment.durationMs > file.facts.videoDurationMs) {
        return this.terminal(input.attemptId, "failed", "片段裁切范围超出实际源视频时长。");
      }
      const seconds = segment.durationMs / 1000;
      const trim = segment.kind === "video" ? `trim=start=${segment.startMs / 1000}:duration=${seconds}` : `trim=duration=${seconds}`;
      filter.push(`[${file.index}:v]${trim},setpts=PTS-STARTPTS,scale=${parameters.width}:${parameters.height}:force_original_aspect_ratio=decrease,pad=${parameters.width}:${parameters.height}:(ow-iw)/2:(oh-ih)/2,fps=${parameters.fps},setsar=1[v${order}]`);
      filter.push(segment.kind === "video" && file.facts?.hasAudio
        ? `[${file.index}:a]atrim=start=${segment.startMs / 1000}:duration=${seconds},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${segment.originalGain ?? 1},apad=whole_dur=${seconds},atrim=duration=${seconds}[a${order}]`
        : `anullsrc=r=48000:cl=stereo:d=${seconds},aformat=sample_fmts=fltp:channel_layouts=stereo[a${order}]`);
    }
    filter.push(`${parameters.segments.map((_, order) => `[v${order}]`).join("")}concat=n=${parameters.segments.length}:v=1:a=0[vout]`);
    filter.push(`${parameters.segments.map((_, order) => `[a${order}]`).join("")}concat=n=${parameters.segments.length}:v=0:a=1[original]`);
    const mix = ["[original]"];
    if (music && parameters.music) {
      const plan = parameters.music;
      const effects = [
        "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo",
        `atrim=start=${plan.sourceStartMs / 1000}:duration=${plan.sourceDurationMs / 1000}`, "asetpts=PTS-STARTPTS",
      ];
      // aloop 的 size 是重采样后的每声道样本数；只缓存选区，不循环整份源文件。
      if (plan.repeat) effects.push(`aloop=loop=-1:size=${plan.sourceDurationMs * 48}:start=0`);
      effects.push(`atrim=duration=${plan.playDurationMs / 1000}`, "asetpts=N/SR/TB", `volume=${plan.gain}`);
      if (plan.fadeInMs > 0) effects.push(`afade=t=in:st=0:d=${plan.fadeInMs / 1000}`);
      if (plan.fadeOutMs > 0) effects.push(`afade=t=out:st=${(plan.playDurationMs - plan.fadeOutMs) / 1000}:d=${plan.fadeOutMs / 1000}`);
      // 延迟后的首个静音帧可能没有 PTS；按样本重建时间戳，避免混音提前播放循环选区。
      effects.push(`adelay=delays=${plan.timelineStartMs}:all=1`, "asetpts=N/SR/TB", `apad=whole_dur=${targetSeconds}`, `atrim=duration=${targetSeconds}`);
      filter.push(`[${music.index}:a]${effects.join(",")}[music]`);
      mix.push("[music]");
    }
    if (narration && parameters.narration) {
      const plan = parameters.narration;
      // 配音仅重采样、增益、起播与补尾；不能 atrim、变速或循环完整配音。
      filter.push(`[${narration.index}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${plan.gain},adelay=delays=${plan.timelineStartMs}:all=1,asetpts=N/SR/TB,apad=whole_dur=${targetSeconds}[narration]`);
      if (music && parameters.music?.duckUnderNarration && plan.gain > 0) {
        filter.push("[narration]asplit=2[narrationMix][narrationControl]");
        filter.push("[music][narrationControl]sidechaincompress=threshold=0.02:ratio=8:attack=10:release=250:makeup=1[duckedMusic]");
        mix[1] = "[duckedMusic]";
        mix.push("[narrationMix]");
      } else mix.push("[narration]");
    }
    // 不按轨数归一；limiter 禁用自动增益并补偿 lookahead，保持冻结音量和时间位置。
    filter.push(`${mix.join("")}amix=inputs=${mix.length}:duration=first:normalize=0,alimiter=limit=0.95:level=false:latency=true[aout]`);
    const attemptDir = path.join(this.options.workRoot, input.attemptId);
    const temporary = path.join(attemptDir, "output.part");
    const finalFile = path.join(attemptDir, "output.mp4");
    const args = ["-y", "-hide_banner", "-loglevel", "error", ...inputArgs.flat(),
      "-filter_complex", filter.join(";"), "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", "-t", String(targetSeconds), "-f", "mp4", temporary];
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    if (signal?.aborted) return this.terminal(input.attemptId, "cancelled", "本地渲染已停止。");
    const outcome = await this.runFfmpeg(input.attemptId, args, signal);
    if (outcome.kind !== "completed") {
      return this.terminal(input.attemptId, outcome.kind === "terminated" ? "cancelled" : "failed", outcome.detail ?? "本地渲染进程未成功结束。");
    }
    let outputFacts: VideoFileFacts;
    try { outputFacts = await probeVideoFile(temporary, this.options.ffprobePath); }
    catch (error) {
      return this.terminal(input.attemptId, "failed", `混音输出不可读：${error instanceof Error ? error.message : String(error)}`);
    }
    if (outputFacts.width !== parameters.width || outputFacts.height !== parameters.height || outputFacts.frameRate !== parameters.fps || !outputFacts.hasAudio) {
      return this.terminal(input.attemptId, "failed", "混音输出规格不符，要求 1280x720 / 24fps / 含声音轨。");
    }
    const toleranceMs = Math.ceil(((parameters.segments.length + 1) * 1000) / parameters.fps) + 40;
    if (Math.abs(outputFacts.durationMs - targetMs) > toleranceMs) {
      return this.terminal(input.attemptId, "failed", `混音输出时长 ${outputFacts.durationMs} ms 与片段总长 ${targetMs} ms 不符。`);
    }
    renameSync(temporary, finalFile);
    const blob = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(finalFile), "video/mp4", outputFacts.durationMs);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), input.attemptId,
      { blobId: blob.id, digest: blob.digest, exitKind: "completed" }))();
    return this.succeeded(input.attemptId, blob.id, blob.digest);
  }

  async query(query: RecoveryQuery): Promise<ExecutionObservation> {
    const run = runRow(this.db, query.runId);
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.blob_id && receipt.digest) {
      const blob = this.blobs.get(run.owner_id, receipt.blob_id);
      if (blob.digest === receipt.digest) {
        try { this.blobs.verify(blob); return this.succeeded(query.attemptId, blob.id, blob.digest); }
        catch { /* 成品文件缺失：如实返回未知，等待人工核对。 */ }
      }
    }
    if (receipt?.exit_kind === "failed") return this.terminal(query.attemptId, "failed", receipt.detail ?? "本地渲染未成功。");
    if (receipt?.exit_kind === "terminated") return this.terminal(query.attemptId, "cancelled", receipt.detail ?? "本地渲染已停止。");
    // 收据缺失但确定性位置已有完整成品：重新探测并补齐收据（文件完成而业务未提交的窗口）。
    const finalFile = path.join(this.options.workRoot, query.attemptId, "output.mp4");
    let facts: VideoFileFacts;
    try { facts = await probeVideoFile(finalFile, this.options.ffprobePath); }
    catch (error) {
      if (!(error instanceof InvalidVideoFile)) throw error;
      // 成品尚不可读：稳定 unknown，保留本地占用，不自动重新渲染。
      return this.stableUnknown(query.attemptId, "本地执行没有退出证据；保留本地执行占用，不会重新渲染或重新提交。");
    }
    const blob = this.blobs.persist(run.owner_id, run.conversation_id, readFileSync(finalFile), "video/mp4", facts.durationMs);
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), query.attemptId,
      { blobId: blob.id, digest: blob.digest, exitKind: "completed" }))();
    return this.succeeded(query.attemptId, blob.id, blob.digest);
  }

  async cancel(query: RecoveryQuery): Promise<ExecutionObservation> {
    const tracked = this.tracked.get(query.attemptId);
    if (!tracked) return this.stableUnknown(query.attemptId, "没有仍在运行的本地渲染进程，尚未确认取消。");
    tracked.child.kill("SIGTERM");
    await tracked.done;
    const receipt = attemptOutput(this.db, query.attemptId);
    if (receipt?.exit_kind === "terminated") return this.terminal(query.attemptId, "cancelled", "本地渲染进程已停止。");
    if (receipt?.exit_kind === "completed" && receipt.blob_id && receipt.digest) return this.succeeded(query.attemptId, receipt.blob_id, receipt.digest);
    return this.stableUnknown(query.attemptId, "本地渲染已发出停止信号，结果尚未核实。");
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.tracked.values()].map(tracked => tracked.done));
  }

  // —— 内部 ——

  private async runFfmpeg(attemptId: string, args: string[], signal?: AbortSignal): Promise<{ kind: "completed" } | { kind: "failed" | "terminated"; detail?: string }> {
    const child = spawn(this.options.ffmpegPath ?? "ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    const stop = () => { child.kill("SIGTERM"); };
    signal?.addEventListener("abort", stop, { once: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8"); });
    const done = new Promise<void>(resolve => child.once("exit", resolve));
    this.tracked.set(attemptId, { child, done });
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      await done;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", stop);
      this.tracked.delete(attemptId);
    }
    const exitCode = child.exitCode;
    const exitSignal = child.signalCode;
    if (exitCode === 0) return { kind: "completed" };
    // 只有 cancel() 发出的 SIGTERM 是用户停止；超时 SIGKILL 归为失败。
    const terminated = exitSignal === "SIGTERM";
    const detail = `本地渲染进程退出异常（exit=${exitCode ?? "null"} signal=${exitSignal ?? "null"}）：${stderr.trim().slice(0, 400) || "无 stderr 输出"}。`;
    return { kind: terminated ? "terminated" : "failed", detail };
  }

  // 失败/取消的确定性观测：同一 attempt 反复查询得到同一条观测（observedAt 取运行创建时间）。
  private terminal(attemptId: string, state: "failed" | "cancelled", message: string): ExecutionObservation {
    this.db.transaction(() => recordAttemptOutput(this.db, this.clock(), attemptId, { exitKind: state === "cancelled" ? "terminated" : "failed", detail: message }))();
    return {
      observationId: this.deterministicId(attemptId, state), attemptId, state,
      providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId),
      message, billing: null,
    };
  }

  private succeeded(attemptId: string, blobId: string, digest: string): ExecutionObservation {
    return {
      observationId: this.deterministicId(attemptId, "succeeded"), attemptId, state: "succeeded",
      providerTaskId: null, blob: { id: blobId, digest, mimeType: "video/mp4" },
      observedAt: this.stableTime(attemptId), message: "本地拼接完成。", billing: null,
    };
  }

  private stableUnknown(attemptId: string, message: string): ExecutionObservation {
    return {
      observationId: this.deterministicId(attemptId, "unknown"), attemptId, state: "unknown",
      providerTaskId: null, blob: null, observedAt: this.stableTime(attemptId),
      message, billing: null,
    };
  }

  private deterministicId(attemptId: string, state: string): string {
    return `obs-${digestOf({ attemptId, scope: "local-render", state }).slice(0, 24)}`;
  }

  private stableTime(attemptId: string): string {
    const row = this.db.prepare("SELECT r.created_at AS at FROM production_runs r JOIN production_attempts a ON a.run_id=r.id WHERE a.id=?").get(attemptId) as { at: string } | undefined;
    return row?.at ?? this.clock();
  }
}
