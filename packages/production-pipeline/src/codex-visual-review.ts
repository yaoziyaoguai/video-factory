import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { CodexBridgeClient, CodexTaskExecution } from "./codex-chat.js";

export interface VisualReviewFramePayload {
  timecodeMs: number;
  sha256: string;
  jpegBase64: string;
  scenePosition?: number;
  phase?: "opening" | "middle" | "closing" | "hook" | "midpoint" | "keyframe";
}

export interface VisualReviewMediaPayload {
  durationMs: number;
  frames: VisualReviewFramePayload[];
  sampling?: {
    mode: "scene_triplets" | "hook_and_scene_midpoints" | "scene_change_keyframes";
    sceneCount?: number;
    coveredScenePositions?: number[];
    missingScenePositions?: number[];
  };
  reviewContext?: Record<string, unknown>;
}

export interface VisualReviewAgentInput {
  videoPath: string;
  runRoot: string;
  scriptPath?: string;
  directorPlanPath?: string;
  renderManifestPath?: string;
  requestId?: string;
}

export interface VisualReviewMediaPreprocessor {
  prepare(input: {
    videoPath: string;
    runRoot: string;
    renderManifestPath?: string;
  }): Promise<VisualReviewMediaPayload>;
}

export type VisualReviewExecution = CodexTaskExecution<VisualReviewReport> & {
  requestId?: string;
  inspectedDurationMs?: number;
  sampling?: VisualReviewMediaPayload["sampling"];
};

export interface VisualReviewFinding {
  timecodeMs: number;
  category: "composition" | "continuity" | "pacing" | "legibility" | "safety" | "other";
  severity: "info" | "warning" | "critical";
  description: string;
  suggestion: string;
}

export interface VisualReviewReport {
  version: "video-factory/visual-review-v1";
  summary: string;
  scores: { composition: number; continuity: number; pacing: number; legibility: number; safety: number };
  findings: VisualReviewFinding[];
  confidence: number;
  recommendation: "approve" | "revise" | "reject";
}

export interface VisualReviewAgent {
  id: string;
  modelId: string;
  review(input: VisualReviewAgentInput): Promise<VisualReviewReport>;
  reviewDetailed?(input: VisualReviewAgentInput): Promise<VisualReviewExecution>;
}

export interface CodexVisualReviewAgentOptions {
  client: Pick<CodexBridgeClient, "runTask"> & Partial<Pick<CodexBridgeClient, "runTaskDetailed">>;
  media: VisualReviewMediaPreprocessor;
  providerId?: string;
  modelId?: string;
}

export class CodexVisualReviewAgent implements VisualReviewAgent {
  readonly id: string;
  readonly modelId: string;

  constructor(private readonly options: CodexVisualReviewAgentOptions) {
    this.id = options.providerId ?? "codex-visual-review-v1";
    this.modelId = options.modelId ?? "codex-default";
  }

  async review(input: VisualReviewAgentInput): Promise<VisualReviewReport> {
    const { payload } = await this.preparePayload(input);
    return validateVisualReviewReport(
      await this.options.client.runTask("visual-review", payload, normalizedRequestId(input.requestId)),
      payload.durationMs,
    );
  }

  async reviewDetailed(input: VisualReviewAgentInput): Promise<VisualReviewExecution> {
    const { payload, sampling } = await this.preparePayload(input);
    const client = this.options.client as Pick<CodexBridgeClient, "runTask" | "runTaskDetailed">;
    const requestId = normalizedRequestId(input.requestId);
    if (typeof client.runTaskDetailed !== "function") {
      return {
        output: validateVisualReviewReport(await client.runTask("visual-review", payload, requestId), payload.durationMs),
        ...(requestId ? { requestId } : {}),
        inspectedDurationMs: payload.durationMs,
        ...(sampling ? { sampling } : {}),
      };
    }
    const execution = await client.runTaskDetailed("visual-review", payload, requestId);
    return {
      output: validateVisualReviewReport(execution.output, payload.durationMs),
      ...(requestId ? { requestId } : {}),
      inspectedDurationMs: payload.durationMs,
      ...(sampling ? { sampling } : {}),
      ...(execution.trace ? { trace: execution.trace } : {}),
    };
  }

  private async preparePayload(input: VisualReviewAgentInput): Promise<{
    payload: VisualReviewMediaPayload;
    sampling?: VisualReviewMediaPayload["sampling"];
  }> {
    const media = await this.options.media.prepare(input);
    const { sampling, ...boundedMedia } = media;
    const reviewContext = await buildReviewContext(input, sampling);
    return {
      payload: { ...boundedMedia, ...(reviewContext ? { reviewContext } : {}) },
      ...(sampling ? { sampling } : {}),
    };
  }
}

function normalizedRequestId(value: string | undefined): string | undefined {
  return value ? `visual-${createHash("sha256").update(value).digest("hex")}` : undefined;
}

async function buildReviewContext(
  input: VisualReviewAgentInput,
  sampling?: VisualReviewMediaPayload["sampling"],
): Promise<Record<string, unknown> | undefined> {
  const entries = await Promise.all([
    input.scriptPath ? readRunJson(input.runRoot, input.scriptPath, "script") : undefined,
    input.directorPlanPath ? readRunJson(input.runRoot, input.directorPlanPath, "director plan") : undefined,
    input.renderManifestPath ? readRunJson(input.runRoot, input.renderManifestPath, "render manifest") : undefined,
  ]);
  const [script, directorPlan, renderManifest] = entries;
  if (!script && !directorPlan && !renderManifest && !sampling) return undefined;
  const context = {
    ...(sampling ? { sampling: {
      ...sampling,
      phases: sampling.mode === "scene_triplets" ? ["opening", "middle", "closing"] : sampling.mode === "hook_and_scene_midpoints" ? ["hook", "midpoint"] : ["keyframe"],
      evidenceBoundary: sampling.mode === "scene_triplets"
        ? "Triplets can show state progression; audio and frame-to-frame smoothness are reviewed separately."
        : "Sparse samples do not prove per-scene state progression, audio, or frame-to-frame smoothness.",
    } } : {}),
    ...(script ? { script: compactScript(script) } : {}),
    ...(directorPlan ? { directorPlan: compactDirectorPlan(directorPlan) } : {}),
    ...(renderManifest ? { renderManifest: compactRenderManifest(renderManifest) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > 128 * 1024) {
    throw new Error("Visual review context exceeds 131072 bytes after compaction.");
  }
  return context;
}

async function readRunJson(runRoot: string, sourcePath: string, label: string): Promise<Record<string, unknown>> {
  const [root, target] = await Promise.all([realpath(runRoot), realpath(sourcePath)]);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Visual review ${label} is outside the run directory.`);
  }
  const content = await readFile(target, "utf8");
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) {
    throw new Error(`Visual review ${label} exceeds 524288 bytes.`);
  }
  const parsed = JSON.parse(content) as unknown;
  return record(parsed, `visual review ${label}`);
}

function compactScript(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["title", "viewerPromise", "narrativeArc", "hook", "duration_target", "platform_notes", "scenes"]);
}

function compactDirectorPlan(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"]);
}

function compactRenderManifest(value: Record<string, unknown>): Record<string, unknown> {
  return pick(value, ["title", "duration_target", "resolution", "slides", "visual_quality", "probe", "aigc"]);
}

function pick(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function validateVisualReviewReport(value: unknown, durationMs: number): VisualReviewReport {
  const report = record(value, "visual review");
  if (report.version !== "video-factory/visual-review-v1") throw new Error("Visual review version is invalid.");
  const scores = record(report.scores, "visual review scores");
  const parsedScores = {
    composition: score(scores.composition, "composition"),
    continuity: score(scores.continuity, "continuity"),
    pacing: score(scores.pacing, "pacing"),
    legibility: score(scores.legibility, "legibility"),
    safety: score(scores.safety, "safety"),
  };
  if (!Array.isArray(report.findings) || report.findings.length > 50) throw new Error("Visual review findings are invalid.");
  const findings = report.findings.map((item, index): VisualReviewFinding => {
    const finding = record(item, `visual review finding ${index}`);
    const timecodeMs = finding.timecodeMs;
    if (!Number.isInteger(timecodeMs) || Number(timecodeMs) < 0 || Number(timecodeMs) > durationMs) throw new Error("Visual review finding timecode is invalid.");
    const category = enumValue(finding.category, ["composition", "continuity", "pacing", "legibility", "safety", "other"] as const, "category");
    const severity = enumValue(finding.severity, ["info", "warning", "critical"] as const, "severity");
    return { timecodeMs: Number(timecodeMs), category, severity, description: text(finding.description, "description"), suggestion: text(finding.suggestion, "suggestion") };
  });
  const confidence = report.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error("Visual review confidence is invalid.");
  const requestedRecommendation = enumValue(
    report.recommendation,
    ["approve", "revise", "reject"] as const,
    "recommendation",
  );
  return {
    version: "video-factory/visual-review-v1",
    summary: text(report.summary, "summary"),
    scores: parsedScores,
    findings,
    confidence,
    recommendation: normalizeRecommendation(requestedRecommendation, parsedScores, findings, confidence),
  };
}

function normalizeRecommendation(
  requested: VisualReviewReport["recommendation"],
  scores: VisualReviewReport["scores"],
  findings: VisualReviewFinding[],
  confidence: number,
): VisualReviewReport["recommendation"] {
  if (requested === "reject" || findings.some((finding) => finding.severity === "critical")) return "reject";
  const minimumScore = Math.min(...Object.values(scores));
  if (
    requested === "revise"
    || findings.some((finding) => finding.severity === "warning")
    || minimumScore < 75
    || confidence < 0.7
  ) return "revise";
  return "approve";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function score(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 100) throw new Error(`Visual review ${label} score is invalid.`);
  return Number(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Visual review ${label} is invalid.`);
  return value.trim();
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`Visual review ${label} is invalid.`);
  return value as T;
}
