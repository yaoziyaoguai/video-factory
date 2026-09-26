import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { VisualReviewMediaPayload, VisualReviewMediaPreprocessor } from "@video-factory/production-pipeline";
import { PlanContractError } from "@video-factory/production-pipeline";
import { buildStudioChildEnvironment } from "./studio-child-environment.js";

const execFile = promisify(execFileCallback);
const MAX_REVIEW_FRAMES = 24;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const REVIEW_MEDIA_TIMEOUT_MS = 10 * 60 * 1000;
// 子进程 stderr 只保留尾部用于定位；完整内容走服务端日志，不进错误消息。
const MAX_LOGGED_CHILD_STDERR = 4_000;

export interface ReviewMediaPrepareInput {
  videoPath?: string;
  assetPlanPath?: string;
  runRoot: string;
  renderManifestPath?: string;
  scenePositions?: number[];
  scriptPath?: string;
  executablePlanPath?: string;
}

export interface PythonReviewMediaPreprocessorOptions {
  repositoryRoot: string;
  pythonPath: string;
  pythonCommand: string;
  environment?: NodeJS.ProcessEnv;
  /** 子进程失败的原始细节（可能含本地绝对路径）只允许走这里，绝不能进错误消息。 */
  logChildFailure?: (message: string) => void;
}

export class PythonReviewMediaPreprocessor implements VisualReviewMediaPreprocessor {
  // 双分支复审会并发请求同一份素材证据。同一份证据只需预处理一次：各跑一次既白付一倍
  // ffmpeg，又让两个临时目录去抢同一个发布目标（Python 侧 os.replace 交错时以
  // "Directory not empty" 失败，且这个失败会伪装成模型调用失败）。只合并同时进行的
  // 相同请求，落地即删，不做跨次缓存——素材变了必须重新采帧。
  private readonly inFlight = new Map<string, Promise<VisualReviewMediaPayload>>();

  constructor(private readonly options: PythonReviewMediaPreprocessorOptions) {}

  async prepare(input: ReviewMediaPrepareInput): Promise<VisualReviewMediaPayload> {
    const key = mediaPreparationKey(input);
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.prepareFresh(input);
      this.inFlight.set(key, pending);
    }
    try {
      // 每个调用方拿自己的副本：分支内的原地改写不能泄漏给另一分支，也不能改写共同快照。
      return structuredClone(await pending);
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  private async prepareFresh(input: ReviewMediaPrepareInput): Promise<VisualReviewMediaPayload> {
    const command = [
      "-m", "video_factory.review_media",
      ...(input.assetPlanPath ? ["--asset-plan", input.assetPlanPath] : ["--video", requiredVideoPath(input.videoPath)]),
      "--run-root", input.runRoot,
      "--max-frames", String(MAX_REVIEW_FRAMES),
      ...(input.renderManifestPath ? ["--render-manifest", input.renderManifestPath] : []),
      ...(input.scenePositions ? ["--scene-positions", ...input.scenePositions.map(String)] : []),
      ...(input.assetPlanPath && input.scriptPath ? ["--script", input.scriptPath] : []),
      ...(input.assetPlanPath && input.executablePlanPath ? ["--executable-plan", input.executablePlanPath] : []),
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFile(this.options.pythonCommand, command, {
        cwd: this.options.repositoryRoot,
        env: buildStudioChildEnvironment(this.options.environment ?? process.env, { PYTHONPATH: this.options.pythonPath }),
        timeout: REVIEW_MEDIA_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      }));
    } catch (error) {
      // 这里曾经是裸 catch：退出码和 stderr 全丢，对外只剩一句"调用失败"，排查只能靠猜。
      // 子进程文本可能含本地绝对路径，所以只送服务端日志；错误消息里不带任何子进程产物。
      (this.options.logChildFailure ?? defaultChildFailureLog)(describeChildFailure(this.options.pythonCommand, error));
      const failure = error as { code?: unknown; stdout?: unknown };
      if (failure.code === 2 && typeof failure.stdout === "string") {
        let payload: unknown;
        try { payload = JSON.parse(failure.stdout.trim()); } catch { /* 非协议输出仍走通用预处理错误。 */ }
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const value = payload as Record<string, unknown>;
          if (value.version === "video-factory/review-media-error-v1" && value.code === "SOURCE_RANGE_TOO_SHORT"
            && Array.isArray(value.scenePositions) && value.scenePositions.length > 0 && value.scenePositions.length <= 24
            && value.scenePositions.every(position => Number.isInteger(position) && Number(position) > 0 && Number(position) <= 10_000)) {
            throw new PlanContractError("SOURCE_RANGE_TOO_SHORT", [...new Set(value.scenePositions as number[])],
              "实际素材不足以覆盖已确认的镜头时段；需要重新匹配素材，不是审片模型故障。");
          }
        }
      }
      throw new Error(`Visual-review media preprocessing failed (${childFailureReason(error)}). The source video and local paths were not sent to the client.`);
    }
    const response = parseRecord(JSON.parse(stdout.trim()) as unknown, "review media response");
    if (typeof response.manifestPath !== "string") throw new Error("Review media response is missing manifestPath.");
    const [root, manifestPath] = await Promise.all([realpath(input.runRoot), realpath(response.manifestPath)]);
    assertConfined(manifestPath, root);
    const manifest = parseRecord(JSON.parse(await readFile(manifestPath, "utf8")) as unknown, "review media manifest");
    if (manifest.version !== "video-factory/review-media-v1" || !Number.isInteger(manifest.durationMs) || Number(manifest.durationMs) <= 0) {
      throw new Error("Review media manifest metadata is invalid.");
    }
    if (!Array.isArray(manifest.frames) || manifest.frames.length < 1 || manifest.frames.length > MAX_REVIEW_FRAMES) {
      throw new Error("Review media manifest frame count is invalid.");
    }
    let totalBytes = 0;
    let previousTimecode = -1;
    const frames: VisualReviewMediaPayload["frames"] = [];
    for (const [index, value] of manifest.frames.entries()) {
      const frame = parseRecord(value, `review frame ${index}`);
      const relativePath = typeof frame.path === "string" ? frame.path : "";
      const timecodeMs = frame.timestampMs;
      const sha256 = frame.sha256;
      if (!relativePath || path.isAbsolute(relativePath) || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Review frame descriptor is invalid.");
      if (!Number.isInteger(timecodeMs) || Number(timecodeMs) <= previousTimecode || Number(timecodeMs) > Number(manifest.durationMs)) throw new Error("Review frame timestamps are invalid.");
      previousTimecode = Number(timecodeMs);
      const framePath = await realpath(path.join(root, relativePath));
      assertConfined(framePath, root);
      const jpeg = await readFile(framePath);
      totalBytes += jpeg.length;
      if (jpeg.length > MAX_FRAME_BYTES || totalBytes > MAX_TOTAL_BYTES || !isJpeg(jpeg)) throw new Error("Review frame bytes exceed the safe visual-review boundary.");
      if (createHash("sha256").update(jpeg).digest("hex") !== sha256) throw new Error("Review frame SHA-256 does not match its manifest.");
      const scenePosition = frame.scenePosition;
      const phase = frame.phase;
      const sourceTimecodeMs = frame.sourceTimecodeMs;
      if (scenePosition !== undefined && (!Number.isInteger(scenePosition) || Number(scenePosition) < 1)) throw new Error("Review frame scene mapping is invalid.");
      if (phase !== undefined && !["opening", "middle", "closing", "hook", "midpoint", "keyframe"].includes(String(phase))) throw new Error("Review frame phase is invalid.");
      if (sourceTimecodeMs !== undefined && (!Number.isInteger(sourceTimecodeMs) || Number(sourceTimecodeMs) < 0)) throw new Error("Review frame source timecode is invalid.");
      frames.push({
        timecodeMs: Number(timecodeMs),
        sha256,
        jpegBase64: jpeg.toString("base64"),
        ...(sourceTimecodeMs !== undefined ? { sourceTimecodeMs: Number(sourceTimecodeMs) } : {}),
        ...(scenePosition !== undefined ? { scenePosition: Number(scenePosition) } : {}),
        ...(phase !== undefined ? { phase: phase as "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe" } : {}),
      });
    }
    const sampling = parseSampling(manifest.sampling, frames);
    if (input.scenePositions && (input.scenePositions.length === 0
      || input.scenePositions.some((position) => !frames.some((frame) => frame.scenePosition === position))
      || frames.some((frame) => !input.scenePositions!.includes(frame.scenePosition!)))) {
      throw new Error("Pilot review evidence does not cover exactly the requested scenes.");
    }
    return { durationMs: Number(manifest.durationMs), frames, ...(sampling ? { sampling } : {}) };
  }
}

function requiredVideoPath(value: string | undefined): string {
  if (!value) throw new Error("Visual-review preprocessing requires a video or asset plan.");
  return value;
}

/**
 * 预处理身份。命令里出现的每个字段都会改变产出的证据，所以全部入键：只要有一个不同就
 * 各跑各的。宁可少合并也不能把两份不同证据当成一份发出去。
 */
function mediaPreparationKey(input: ReviewMediaPrepareInput): string {
  return JSON.stringify([
    input.runRoot,
    input.assetPlanPath ?? null,
    input.videoPath ?? null,
    input.renderManifestPath ?? null,
    input.scenePositions ?? null,
    input.scriptPath ?? null,
    input.executablePlanPath ?? null,
  ]);
}

function childFailureReason(error: unknown): string {
  const failure = error as { killed?: unknown; signal?: unknown; code?: unknown };
  if (failure.killed === true) return `timed out after ${REVIEW_MEDIA_TIMEOUT_MS / 1000}s`;
  if (typeof failure.signal === "string") return `terminated by ${failure.signal}`;
  if (typeof failure.code === "number") return `exit code ${failure.code}`;
  if (typeof failure.code === "string") return `could not start the preprocessor (${failure.code})`;
  return "no exit status";
}

function describeChildFailure(pythonCommand: string, error: unknown): string {
  const failure = error as { stderr?: unknown };
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const tail = stderr.length > MAX_LOGGED_CHILD_STDERR ? stderr.slice(-MAX_LOGGED_CHILD_STDERR) : stderr;
  return [
    `[review-media] preprocessing child failed: ${childFailureReason(error)}`,
    `command: ${path.basename(pythonCommand)}`,
    `stderr: ${tail || "(empty)"}`,
  ].join("\n");
}

function defaultChildFailureLog(message: string): void {
  console.error(message);
}

function parseSampling(
  value: unknown,
  frames: VisualReviewMediaPayload["frames"],
): VisualReviewMediaPayload["sampling"] | undefined {
  if (value === undefined) return undefined;
  const sampling = parseRecord(value, "review media sampling");
  if (!["scene_triplets", "scene_sequence", "hook_and_scene_midpoints", "scene_change_keyframes"].includes(String(sampling.mode))) {
    throw new Error("Review media sampling mode is invalid.");
  }
  if (sampling.sceneCount !== undefined && (!Number.isInteger(sampling.sceneCount) || Number(sampling.sceneCount) < 1)) {
    throw new Error("Review media sampling sceneCount is invalid.");
  }
  const mode = sampling.mode as "scene_triplets" | "scene_sequence" | "hook_and_scene_midpoints" | "scene_change_keyframes";
  const sceneCount = sampling.sceneCount === undefined ? undefined : Number(sampling.sceneCount);
  if (mode === "scene_triplets" && sceneCount === undefined) {
    throw new Error("Scene-triplet sampling requires sceneCount.");
  }
  const coveredScenePositions = [...new Set(frames.flatMap((frame) => frame.scenePosition === undefined ? [] : [frame.scenePosition]))]
    .sort((left, right) => left - right);
  if (sceneCount !== undefined && coveredScenePositions.some((position) => position > sceneCount)) {
    throw new Error("Review frame scene mapping exceeds sampling sceneCount.");
  }
  const missingScenePositions = sceneCount === undefined
    ? []
    : Array.from({ length: sceneCount }, (_, index) => index + 1).filter((position) => !coveredScenePositions.includes(position));
  if (mode === "scene_triplets") {
    const requiredPhases = ["opening", "middle", "closing"] as const;
    for (let position = 1; position <= sceneCount!; position += 1) {
      const phases = frames.filter((frame) => frame.scenePosition === position).map((frame) => frame.phase);
      if (phases.length !== 3 || new Set(phases).size !== 3 || !requiredPhases.every((phase) => phases.includes(phase))) {
        throw new Error(`Scene-triplet sampling is incomplete for scene ${position}.`);
      }
    }
  }
  return {
    mode,
    ...(sceneCount !== undefined ? {
      sceneCount,
      coveredScenePositions,
      missingScenePositions,
    } : {}),
  };
}

function parseRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertConfined(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Review media path escapes the selected run.");
}

function isJpeg(value: Buffer): boolean {
  return value.length >= 5 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff && value.at(-2) === 0xff && value.at(-1) === 0xd9;
}
