import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { VisualReviewMediaPayload, VisualReviewMediaPreprocessor } from "@video-factory/production-pipeline";
import { buildStudioChildEnvironment } from "./studio-child-environment.js";

const execFile = promisify(execFileCallback);
const MAX_REVIEW_FRAMES = 24;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export interface PythonReviewMediaPreprocessorOptions {
  repositoryRoot: string;
  pythonPath: string;
  pythonCommand: string;
  environment?: NodeJS.ProcessEnv;
}

export class PythonReviewMediaPreprocessor implements VisualReviewMediaPreprocessor {
  constructor(private readonly options: PythonReviewMediaPreprocessorOptions) {}

  async prepare(input: {
    videoPath?: string;
    assetPlanPath?: string;
    runRoot: string;
    renderManifestPath?: string;
  }): Promise<VisualReviewMediaPayload> {
    const command = [
      "-m", "video_factory.review_media",
      ...(input.assetPlanPath ? ["--asset-plan", input.assetPlanPath] : ["--video", requiredVideoPath(input.videoPath)]),
      "--run-root", input.runRoot,
      "--max-frames", String(MAX_REVIEW_FRAMES),
      ...(input.renderManifestPath ? ["--render-manifest", input.renderManifestPath] : []),
    ];
    let stdout: string;
    try {
      ({ stdout } = await execFile(this.options.pythonCommand, command, {
        cwd: this.options.repositoryRoot,
        env: buildStudioChildEnvironment(this.options.environment ?? process.env, { PYTHONPATH: this.options.pythonPath }),
        timeout: 10 * 60 * 1000,
        maxBuffer: 64 * 1024,
      }));
    } catch {
      throw new Error("Visual-review media preprocessing failed. The source video and local paths were not sent to the client.");
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
      if (scenePosition !== undefined && (!Number.isInteger(scenePosition) || Number(scenePosition) < 1)) throw new Error("Review frame scene mapping is invalid.");
      if (phase !== undefined && !["opening", "middle", "closing", "hook", "midpoint", "keyframe"].includes(String(phase))) throw new Error("Review frame phase is invalid.");
      frames.push({
        timecodeMs: Number(timecodeMs),
        sha256,
        jpegBase64: jpeg.toString("base64"),
        ...(scenePosition !== undefined ? { scenePosition: Number(scenePosition) } : {}),
        ...(phase !== undefined ? { phase: phase as "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe" } : {}),
      });
    }
    const sampling = parseSampling(manifest.sampling, frames);
    return { durationMs: Number(manifest.durationMs), frames, ...(sampling ? { sampling } : {}) };
  }
}

function requiredVideoPath(value: string | undefined): string {
  if (!value) throw new Error("Visual-review preprocessing requires a video or asset plan.");
  return value;
}

function parseSampling(
  value: unknown,
  frames: VisualReviewMediaPayload["frames"],
): VisualReviewMediaPayload["sampling"] | undefined {
  if (value === undefined) return undefined;
  const sampling = parseRecord(value, "review media sampling");
  if (!["scene_triplets", "hook_and_scene_midpoints", "scene_change_keyframes"].includes(String(sampling.mode))) {
    throw new Error("Review media sampling mode is invalid.");
  }
  if (sampling.sceneCount !== undefined && (!Number.isInteger(sampling.sceneCount) || Number(sampling.sceneCount) < 1)) {
    throw new Error("Review media sampling sceneCount is invalid.");
  }
  const mode = sampling.mode as "scene_triplets" | "hook_and_scene_midpoints" | "scene_change_keyframes";
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
