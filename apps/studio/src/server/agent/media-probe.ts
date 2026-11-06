import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentDatabase } from "./db.js";
import { renderSlotRole } from "./render-inputs.js";
import type { ProductionBlobs } from "./production-blobs.js";
import type { RenderFileProbe } from "./artifact-store.js";
import type { ProductionIntent } from "../../shared/agent/generated/contracts.js";

const run = promisify(execFile);

// 受控 ffprobe：只以固定 argv 查询媒体元数据，不执行任意命令、不接受模型提供的参数。
export interface VideoFileFacts {
  width: number;
  height: number;
  durationMs: number;
  /** 视频轨的画面时段；容器 durationMs 可能因较长音轨而更长。 */
  videoDurationMs: number;
  hasAudio: boolean;
  frameRate: number | null;
  mimeType: "video/mp4" | "video/webm";
}

// 只有 ffprobe 明确拒绝媒体或结构不符才归为坏文件；工具启动/超时错误仍由调用者处理。
export class InvalidVideoFile extends Error {}

export interface ImageFileFacts {
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png";
}

export class InvalidImageFile extends Error {}

export interface AudioFileFacts {
  durationMs: number;
  sampleRate: number;
  channels: number;
  mimeType: "audio/mpeg";
}

export class InvalidAudioFile extends Error {}

// §9.2/§9.3：启动核实一次本机 FFmpeg 工具链（T4 图片与 T5 音频的探测/解码验收共用同一能力集，
// 不要求 libx264——那是本地拼接的编码需求，与媒体验收无关）。
export async function mediaDecodeAvailability(
  ffmpegPath = "ffmpeg",
  ffprobePath = "ffprobe",
): Promise<{ available: boolean; reason: string }> {
  try {
    await run(ffprobePath, ["-version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    return { available: false, reason: "未找到可执行的 ffprobe，媒体输出验收未启用。" };
  }
  try {
    await run(ffmpegPath, ["-version"], { timeout: 10_000, maxBuffer: 64 * 1024 });
  } catch {
    return { available: false, reason: "未找到可执行的 ffmpeg，媒体解码验收未启用。" };
  }
  return { available: true, reason: "媒体探测与解码能力已核实。" };
}

// 复用本机 FFmpeg 解码实际像素；ffprobe 只负责尺寸和格式，不把文件头当解码成功。
// 同时核实图片封装与单帧：单帧 AVI 也可能是 mjpeg，不能仅凭 codec/packet 数认作 JPEG。
export async function probeImageFile(file: string, signal?: AbortSignal): Promise<ImageFileFacts> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-count_packets",
      "-show_entries", "stream=codec_name,width,height,nb_read_packets:format=format_name", "-of", "json", file,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }));
    await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"],
      { timeout: 30_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") throw new InvalidImageFile("图片无法解码。");
    throw error;
  }
  const parsed = JSON.parse(stdout) as { streams?: { codec_name?: string; width?: number; height?: number; nb_read_packets?: string }[]; format?: { format_name?: string } };
  const image = parsed.streams?.[0];
  if (!image?.width || !image.height || (image.codec_name !== "mjpeg" && image.codec_name !== "png")) {
    throw new InvalidImageFile("不是可解码的 JPEG 或 PNG 图片。");
  }
  const formats = image.codec_name === "png" ? ["png_pipe", "image2"] : ["jpeg_pipe", "mjpeg", "image2"];
  if (!formats.includes(parsed.format?.format_name ?? "")) throw new InvalidImageFile("输出不是 JPEG 或 PNG 图片封装。");
  if (image.nb_read_packets !== "1") {
    throw new InvalidImageFile("不是单张图片文件（含多帧视频数据）。");
  }
  return { width: image.width, height: image.height, mimeType: image.codec_name === "png" ? "image/png" : "image/jpeg" };
}

// §9.3：ffprobe 只读元数据；再用 ffmpeg 实际解码一遍，截断/坏字节 MP3 必须在这里被拒绝，
// 不相信扩展名或供应商 extra_info 代替文件本身。
export async function probeAudioFile(file: string, signal?: AbortSignal): Promise<AudioFileFacts> {
  let stdout: string;
  try {
    ({ stdout } = await run("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,channels,sample_rate:format=duration,format_name", "-of", "json", file,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }));
    await run("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-f", "null", "-"],
      { timeout: 60_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") throw new InvalidAudioFile("音频无法解码。");
    throw error;
  }
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_name?: string; channels?: number; sample_rate?: string }[];
    format?: { duration?: string; format_name?: string };
  };
  const audio = parsed.streams?.[0];
  if (!audio || audio.codec_name !== "mp3") throw new InvalidAudioFile("不是可解码的 MP3 音频。");
  if (!parsed.format?.format_name?.split(",").includes("mp3")) throw new InvalidAudioFile("输出不是 MP3 容器。");
  const duration = Number(parsed.format?.duration ?? Number.NaN);
  if (!Number.isFinite(duration) || duration <= 0) throw new InvalidAudioFile("音频时长不可读。");
  return { durationMs: Math.round(duration * 1000), sampleRate: Number(audio.sample_rate), channels: audio.channels ?? 0, mimeType: "audio/mpeg" };
}

export async function probeVideoFile(file: string, ffprobePath = "ffprobe", signal?: AbortSignal): Promise<VideoFileFacts> {
  let stdout: string;
  try {
    ({ stdout } = await run(ffprobePath, [
      "-v", "error", "-show_entries",
      "format=duration,format_name:stream=codec_type,width,height,avg_frame_rate,duration:stream_tags=DURATION",
      "-of", "json", file,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) }));
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") throw new InvalidVideoFile("媒体文件不可读。");
    throw error;
  }
  const parsed = JSON.parse(stdout) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string; tags?: { DURATION?: string } }[];
    format?: { duration?: string; format_name?: string };
  };
  const video = parsed.streams?.find(stream => stream.codec_type === "video");
  if (!video || !video.width || !video.height) throw new InvalidVideoFile("没有可读的视频轨道。");
  // ffprobe 对 WebM 报 "matroska,webm"；只认本管线真实处理的两种容器。
  const container = parsed.format?.format_name?.split(",") ?? [];
  const mimeType = container.includes("mp4") ? "video/mp4" as const : container.includes("webm") ? "video/webm" as const : null;
  if (!mimeType) throw new InvalidVideoFile("输出不是 MP4 或 WebM 容器。");
  const duration = Number(parsed.format?.duration ?? Number.NaN);
  if (!Number.isFinite(duration) || duration <= 0) throw new InvalidVideoFile("视频时长不可读。");
  const hasAudio = Boolean(parsed.streams?.some(stream => stream.codec_type === "audio"));
  // 轨级画面时长：MP4 常见于 stream.duration（秒）；WebM/Matroska 写在视频轨自身标签 DURATION
  // （HH:MM:SS.fraction 的时长格式，不是时刻），有声时容器时长被较长音轨带偏，不能拿来代画面。
  const streamDuration = Number(video.duration ?? Number.NaN);
  let videoDuration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number.NaN;
  if (!(videoDuration > 0) && mimeType === "video/webm") {
    const tag = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(video.tags?.DURATION?.trim() ?? "");
    const tagged = tag ? Number(tag[1]!) * 3600 + Number(tag[2]!) * 60 + Number(tag[3]!) : Number.NaN;
    if (tagged > 0) videoDuration = tagged;
  }
  // 无声文件没有音轨可比，容器时长就是画面时长，保留这个回退。
  if (!(videoDuration > 0) && !hasAudio) videoDuration = duration;
  if (!(videoDuration > 0)) throw new InvalidVideoFile("视频轨时长不可读。");
  const fraction = video.avg_frame_rate?.split("/") ?? [];
  const frameRate = fraction.length === 2 && Number(fraction[1]) > 0 ? Number(fraction[0]) / Number(fraction[1]) : null;
  return {
    width: video.width, height: video.height,
    durationMs: Math.round(duration * 1000), videoDurationMs: Math.round(videoDuration * 1000),
    hasAudio,
    frameRate: frameRate && Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null,
    mimeType,
  };
}

// 付费前探测已有渲染输入文件：render 操作引用的 blob/媒体修订逐个 ffprobe；
// 依赖输出（operation_output）尚未产生，按冻结能力校验、产出后再验证，这里跳过。
export async function probeRenderInputs(
  db: AgentDatabase,
  blobs: ProductionBlobs,
  scope: { ownerId: string; conversationId: string },
  intent: Pick<ProductionIntent, "operations">,
  ffprobePath?: string,
): Promise<Map<string, RenderFileProbe>> {
  const targets = new Map<string, { digest: string; role: "video" | "image" | "audio" }>();
  const blobDigest = (blobId: string): string | undefined =>
    (db.prepare("SELECT digest FROM production_blobs WHERE id=? AND owner_id=? AND conversation_id=?")
      .get(blobId, scope.ownerId, scope.conversationId) as { digest: string } | undefined)?.digest;
  for (const op of intent.operations) {
    if (op.kind !== "render") continue;
    for (const [slot, input] of op.inputs.entries()) {
      const role = renderSlotRole(op.parameters, slot);
      if (role === "none") continue;
      if (input.kind === "blob") {
        const digest = blobDigest(input.blobId);
        if (digest) targets.set(input.blobId, { digest, role });
      } else if (input.kind === "artifact_revision") {
        const content = db.prepare("SELECT content_json FROM artifact_revisions WHERE artifact_id=? AND id=?")
          .get(input.artifactId, input.revisionId) as { content_json: string } | undefined;
        const parsed = content ? JSON.parse(content.content_json) as { format?: string; blobId?: string } : undefined;
        if (parsed?.format === "media" && parsed.blobId) {
          const digest = blobDigest(parsed.blobId);
          if (digest) targets.set(parsed.blobId, { digest, role });
        }
      }
    }
  }
  const probes = new Map<string, RenderFileProbe>();
  for (const [blobId, { digest, role }] of targets) {
    try {
      // 按槽位角色探测：旁白槽是音频事实，图片槽核实实际解码，视频槽是视频事实（timed/narrated 画面允许自带原声，执行时明确丢弃）。
      if (role === "audio") probes.set(blobId, { ok: true, kind: "audio", durationMs: (await probeAudioFile(blobs.filePath(digest))).durationMs });
      else if (role === "image") {
        const facts = await probeImageFile(blobs.filePath(digest));
        probes.set(blobId, { ok: true, kind: "image", width: facts.width, height: facts.height });
      } else {
        const facts = await probeVideoFile(blobs.filePath(digest), ffprobePath);
        probes.set(blobId, { ok: true, kind: "video", ...facts });
      }
    } catch (error) {
      if (!(error instanceof InvalidVideoFile || error instanceof InvalidAudioFile || error instanceof InvalidImageFile)) throw error;
      probes.set(blobId, { ok: false, reason: `媒体文件不可读：${String(error instanceof Error ? error.message : error)}` });
    }
  }
  return probes;
}
