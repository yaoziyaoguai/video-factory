import { isDeepStrictEqual } from "node:util";
import type { VoiceDoesNotFitConflict } from "./contracts.js";

export interface NarrationGroupConflict {
  code: "NARRATION_GROUP_DOES_NOT_FIT";
  groupId: string;
  sourceScenePositions: number[];
  window: { startFrame: number; endFrame: number };
  sourceAudioSamples: number;
  requiredFrames: number;
  cuts: Array<{ scenePosition: number; startFrame: number; frameCount: number }>;
  operationId: string;
  audioArtifact: VoiceDoesNotFitConflict["audioArtifact"];
}

export function parseNarrationGroupConflict(value: unknown): NarrationGroupConflict {
  if (!value || typeof value !== "object") throw new Error("缺少连续旁白时序证据。");
  const item = value as NarrationGroupConflict;
  const integer = (number: unknown, minimum = 0): number is number => typeof number === "number" && Number.isSafeInteger(number) && number >= minimum;
  const artifact = item.audioArtifact;
  if (item.code !== "NARRATION_GROUP_DOES_NOT_FIT" || typeof item.groupId !== "string" || !item.groupId.trim()
    || !Array.isArray(item.sourceScenePositions) || !item.sourceScenePositions.length
    || item.sourceScenePositions.some((position, index) => !integer(position, 1) || index > 0 && position !== item.sourceScenePositions[index - 1]! + 1)
    || !item.window || !integer(item.window.startFrame) || !integer(item.window.endFrame, item.window.startFrame + 1)
    || !integer(item.sourceAudioSamples, 1) || !integer(item.requiredFrames, Math.ceil(item.sourceAudioSamples / 1470))
    || item.requiredFrames <= item.window.endFrame - item.window.startFrame
    || typeof item.operationId !== "string" || !item.operationId.trim()
    || !Array.isArray(item.cuts) || item.cuts.length !== item.sourceScenePositions.length
    || item.cuts.some((cut, index) => !cut || cut.scenePosition !== item.sourceScenePositions[index]
      || !integer(cut.frameCount, 1) || cut.startFrame !== (index === 0 ? item.window.startFrame
        : item.cuts[index - 1]!.startFrame + item.cuts[index - 1]!.frameCount))
    || item.cuts.at(-1)!.startFrame + item.cuts.at(-1)!.frameCount !== item.window.endFrame
    || !artifact || artifact.kind !== "voiceover_raw" || typeof artifact.uri !== "string" || !artifact.uri.trim()
    || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !integer(artifact.sizeBytes, 1) || typeof artifact.contentType !== "string" || !artifact.contentType.startsWith("audio/")) {
    throw new Error("连续旁白的分组、画面区间或原音频证据不完整。");
  }
  return structuredClone(item);
}

export interface NarrationPlan {
  version: "video-factory/narration-plan-v1";
  mode: "continuous_groups";
  script: { sha256: string };
  visualPlan: { sha256: string; fps: 30; totalFrames: number };
  edgeTrim: "none";
  subtitleMode: "provider_sentence";
  silences: Array<{ id: string; startFrame: number; endFrame: number; source: "legacy_silent_scene" }>;
  groups: Array<{
    id: string; sourceScenePositions: number[]; text: string;
    window: { startFrame: number; endFrame: number };
    placement: { anchor: "start" | "end"; offsetFrames: number };
  }>;
}

export interface NarrationPlanPreview {
  expectedRunRevision: number;
  plan: NarrationPlan;
  confirmed: boolean;
  quote?: NarrationSpendQuote;
}

export interface NarrationSpendQuote {
  estimatedCostCny: number;
  maxCostCny: number;
  unitPriceCny: string;
  source: "configured_rate";
  items: Array<{ groupId: string; estimatedUnits: number; maxCostCny: number; reused: boolean }>;
}

export interface NarrationSpendRequest {
  runId: string;
  nodeDirectory: string;
  input: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

/** 与 Python 消费合同一致：只组合原稿，不凭换镜添加停顿或改词。 */
export function buildNarrationPlan(scenes: unknown, scriptSha256: string, visualSha256: string): NarrationPlan {
  if (!Array.isArray(scenes) || scenes.length === 0
    || ![scriptSha256, visualSha256].every((hash) => /^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("旁白方案缺少已确认的脚本与画面。");
  }
  const plan: NarrationPlan = {
    version: "video-factory/narration-plan-v1", mode: "continuous_groups",
    script: { sha256: scriptSha256 }, visualPlan: { sha256: visualSha256, fps: 30, totalFrames: 0 },
    edgeTrim: "none", subtitleMode: "provider_sentence", silences: [], groups: [],
  };
  let current: NarrationPlan["groups"][number] | undefined;
  for (const [index, scene] of scenes.entries()) {
    if (!scene || typeof scene !== "object" || scene.position !== index + 1
      || typeof scene.narration !== "string" || typeof scene.duration !== "number"
      || !Number.isFinite(scene.duration) || scene.duration <= 0
      || Math.abs(Math.round(scene.duration * 30) - scene.duration * 30) > 1e-6) {
      throw new Error("旁白方案与正式画面时间线不一致。");
    }
    const startFrame = plan.visualPlan.totalFrames;
    const endFrame = startFrame + Math.round(scene.duration * 30);
    if (endFrame <= startFrame || endFrame > 5400) throw new Error("旁白方案超出短视频时长范围。");
    plan.visualPlan.totalFrames = endFrame;
    if (!/[\p{L}\p{N}]/u.test(scene.narration)) {
      plan.silences.push({ id: `silence-${scene.position}`, startFrame, endFrame, source: "legacy_silent_scene" });
      current = undefined;
      continue;
    }
    if (!current) {
      current = { id: `narration-${scene.position}`, sourceScenePositions: [], text: "",
        window: { startFrame, endFrame }, placement: { anchor: "start", offsetFrames: 0 } };
      plan.groups.push(current);
    }
    current.text += (current.sourceScenePositions.length ? " " : "") + scene.narration.trim();
    current.sourceScenePositions.push(scene.position);
    current.window.endFrame = endFrame;
  }
  return plan;
}

/** 此编辑入口只调整落点；改词请回脚本，改 cuts 请回画面方案，不开放任意路径。 */
export function validateNarrationPlan(value: unknown, expected: NarrationPlan): NarrationPlan {
  if (!value || typeof value !== "object" || !Array.isArray((value as NarrationPlan).groups)) {
    throw new Error("旁白方案格式不正确。");
  }
  const candidate = value as NarrationPlan;
  const normalized = structuredClone(candidate);
  if (candidate.groups.length !== expected.groups.length) throw new Error("旁白分组已变化，请重新查看方案。");
  for (const [index, group] of candidate.groups.entries()) {
    const original = expected.groups[index]!;
    const placement = group?.placement;
    if (!placement || !["start", "end"].includes(placement.anchor)
      || !Number.isSafeInteger(placement.offsetFrames) || placement.offsetFrames < 0
      || placement.offsetFrames >= original.window.endFrame - original.window.startFrame) {
      throw new Error("旁白落点必须位于这一段画面内。");
    }
    normalized.groups[index]!.placement = original.placement;
  }
  if (!isDeepStrictEqual(normalized, expected)) throw new Error("旁白的原稿或画面方案已变化，请重新查看并确认。");
  return structuredClone(candidate);
}
