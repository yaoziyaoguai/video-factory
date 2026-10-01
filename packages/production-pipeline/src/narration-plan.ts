import { createHash } from "node:crypto";
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
  /** §4.2.2：GET 按版本显式分派后返回实际保存的计划；UI 不得假定只有 v1。 */
  plan: SupportedNarrationPlan;
  confirmed: boolean;
  /** v2 编辑器的宿主派生来源身份（§2.2）；初始预览下发，候选/确认请求原样带回。 */
  sourceContextId?: string;
  quote?: NarrationSpendQuote;
  editorContext: {
    mode: "pre_generation" | "voice_stop" | "final_review";
    defaultPlan: NarrationPlan;
    baseGroups: Array<{
      baseGroupId: string;
      text: string;
      endCodePoint: number;
      frameRange: { startFrame: number; endFrame: number };
      allowedBoundaries: number[];
    }>;
    savedPlanStatus: "none" | "current" | "stale";
    stalePlan?: SupportedNarrationPlan;
  };
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

// ══ v2 显式分段合同（narration-text-v1；v1 与无计划路径不受影响） ══

// 纯函数（含 NarrationTextV2Error/trim/wordy/canonicalJson/句界/秒转换）已拆到
// 浏览器安全的 narration-text.ts；此处再导出保持原公共 API 不变。
export {
  NarrationTextV2Error,
  TRIM_CODEPOINT_SET_V2,
  canonicalJsonV2,
  isWordyV2,
  rejectSurrogate,
  secondsToFramesV2,
  sentenceBoundaryCandidatesV2,
  trimV2,
} from "./narration-text.js";
import {
  canonicalJsonV2,
  isWordyV2,
  NarrationTextV2Error,
  rejectSurrogate,
  sentenceBoundaryCandidatesV2,
  TRIM_CODEPOINT_SET_V2,
  trimV2,
} from "./narration-text.js";

function identitySha(payload: unknown): string {
  return createHash("sha256").update(canonicalJsonV2(payload), "utf8").digest("hex");
}

export interface NarrationBaseGroupV2 {
  baseGroupId: string;
  sourceScenePositions: number[];
  canonicalText: string;
  sceneTextRanges: Array<{ position: number; start: number; end: number }>;
  frameRange: { startFrame: number; endFrame: number };
  startCodePoint: number;
  endCodePoint: number;
}

export interface NarrationV2SourceFacts {
  baseGroups: NarrationBaseGroupV2[];
  legacySilences: Array<{ id: string; startFrame: number; endFrame: number }>;
  totalFrames: number;
}

/** 派生基础有词区、镜头静默与总帧：v2 的有词判定统一用冻结规则表（trim 后判 L/N）。 */
export function deriveV2SourceFacts(scenes: Array<{ position: number; narration: string; duration: number }>): NarrationV2SourceFacts {
  const baseGroups: NarrationBaseGroupV2[] = [];
  const legacySilences: Array<{ id: string; startFrame: number; endFrame: number }> = [];
  let current: NarrationBaseGroupV2 | undefined;
  let cursor = 0;
  for (const [index, scene] of scenes.entries()) {
    const position = index + 1;
    const duration = scene?.duration;
    if (typeof scene?.narration !== "string") throw new NarrationTextV2Error("v2 原稿旁白必须是字符串。");
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0
      || Math.abs(Math.round(duration * 30) - duration * 30) > 1e-6) {
      throw new NarrationTextV2Error("v2 基础有词区必须与已确认的 30fps 画面时间线一致。");
    }
    const startFrame = cursor;
    const endFrame = startFrame + Math.round(duration * 30);
    cursor = endFrame;
    if (cursor > 5400) throw new NarrationTextV2Error("v2 计划超出短视频时长范围。");
    const trimmed = trimV2(scene.narration);
    if (!isWordyV2(trimmed)) {
      legacySilences.push({ id: `silence-${position}`, startFrame, endFrame });
      current = undefined;
      continue;
    }
    if (!current) {
      current = { baseGroupId: "", sourceScenePositions: [], canonicalText: "", sceneTextRanges: [],
        frameRange: { startFrame, endFrame }, startCodePoint: 0, endCodePoint: 0 };
      baseGroups.push(current);
    } else {
      // 拼接空格归左镜：延伸上一镜的文字区间到空格之后（例：左[0,3)、右[3,5)）。
      const offsetAfterSpace = Array.from(current.canonicalText).length + 1;
      current.canonicalText += " ";
      const lastRange = current.sceneTextRanges.at(-1)!;
      lastRange.end = offsetAfterSpace;
      current.frameRange.endFrame = endFrame;
    }
    const offset = Array.from(current.canonicalText).length;
    current.canonicalText += trimmed;
    current.sceneTextRanges.push({ position, start: offset, end: offset + Array.from(trimmed).length });
    current.sourceScenePositions.push(position);
  }
  for (const group of baseGroups) {
    group.startCodePoint = 0;
    group.endCodePoint = Array.from(group.canonicalText).length;
    group.baseGroupId = "nb-" + identitySha(["narration-text-v1", group.sourceScenePositions, group.canonicalText]);
  }
  return { baseGroups, legacySilences, totalFrames: cursor };
}

export function deriveBaseGroupsV2(scenes: Array<{ position: number; narration: string; duration: number }>): NarrationBaseGroupV2[] {
  return deriveV2SourceFacts(scenes).baseGroups;
}

/** canonicalSourceSha256：按画面顺序的全部 baseGroup 记录与 legacy 静默的规范 JSON 摘要（两端同字节）。 */
export function canonicalSourceSha256V2(facts: Pick<NarrationV2SourceFacts, "baseGroups" | "legacySilences">): string {
  return identitySha({
    rule: "narration-text-v1",
    baseGroups: facts.baseGroups.map((group) => ({
      id: group.baseGroupId,
      text: group.canonicalText,
      sceneTextRanges: group.sceneTextRanges.map((range) => ({ position: range.position, start: range.start, end: range.end })),
      frameRange: { startFrame: group.frameRange.startFrame, endFrame: group.frameRange.endFrame },
    })),
    legacySilences: facts.legacySilences.map((silence) => ({ id: silence.id, startFrame: silence.startFrame, endFrame: silence.endFrame })),
  });
}

export interface NarrationSliceV2 { start: number; end: number; sourceScenePositions: number[]; text: string }

export function validateSlicesV2(baseGroup: NarrationBaseGroupV2, slices: Array<{ start: number; end: number }>): NarrationSliceV2[] {
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new NarrationTextV2Error("v2 分段不能为空；不需要分段时请走原 v1 连续路径。");
  }
  const units = Array.from(baseGroup.canonicalText);
  const ranges: Array<[number, number]> = [];
  for (const item of slices) {
    const { start, end } = item ?? {};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new NarrationTextV2Error("v2 分段端点必须是整数码点。");
    }
    if (!(0 <= start && start < end && end <= baseGroup.endCodePoint)) {
      throw new NarrationTextV2Error("v2 分段超出该基础有词区范围。");
    }
    ranges.push([start, end]);
  }
  for (const [previous, current] of ranges.slice(1).map((current, index) => [ranges[index]!, current] as const)) {
    if (current[0] < previous[1]) throw new NarrationTextV2Error("v2 分段按文字顺序且不得重叠。");
    // 前段 end 严格等于后段 start：缺口会静默丢掉中间文字。
    if (current[0] > previous[1]) throw new NarrationTextV2Error("v2 分段必须连续：相邻分段存在间隙，会遗漏中间文字。");
  }
  if (ranges[0]![0] !== 0 || ranges.at(-1)![1] !== baseGroup.endCodePoint) {
    throw new NarrationTextV2Error("v2 分段必须完整覆盖基础有词区（无遗漏、无越界）。");
  }
  // 内部切点必须来自宿主合法句界或镜头文字交界，不能任意字符切开。
  const legalBoundaries = new Set<number>([
    ...baseGroup.sceneTextRanges.flatMap((range) => [range.start, range.end]),
    ...sentenceBoundaryCandidatesV2(baseGroup.canonicalText),
  ]);
  for (const [start] of ranges.slice(1)) {
    if (!legalBoundaries.has(start)) {
      throw new NarrationTextV2Error("v2 分段切点必须来自合法句界或镜头边界。");
    }
  }
  return ranges.map(([start, end]) => {
    const positions = [...new Set(baseGroup.sceneTextRanges
      .filter((range) => range.start < end && range.end > start)
      .map((range) => range.position))].sort((a, b) => a - b);
    if (!positions.length) throw new NarrationTextV2Error("v2 分段必须覆盖原稿文字。");
    const text = units.slice(start, end).join("");
    if (!isWordyV2(trimV2(text))) {
      throw new NarrationTextV2Error("v2 分段不得为纯空白段；拼接空格仅允许出现在段边界。");
    }
    return { start, end, sourceScenePositions: positions, text };
  });
}

export interface NarrationUserSilenceV2 { id: string; startFrame: number; endFrame: number; source: "user" }

export function userSilencesV2(
  totalFrames: number,
  legacySilences: Array<{ startFrame: number; endFrame: number }>,
  silences: Array<{ start: number; end: number }>,
): NarrationUserSilenceV2[] {
  const normalized: Array<[number, number]> = [];
  for (const item of silences) {
    const { start, end } = item ?? {};
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new NarrationTextV2Error("用户静默必须是整数帧。");
    }
    if (!(0 <= start && start < end && end <= totalFrames)) {
      throw new NarrationTextV2Error("用户静默超出画面范围。");
    }
    normalized.push([start, end]);
  }
  normalized.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [previous, current] of normalized.slice(1).map((current, index) => [normalized[index]!, current] as const)) {
    if (current[0] < previous[1]) throw new NarrationTextV2Error("用户静默按帧排序且不得重叠。");
  }
  for (const [start, end] of normalized) {
    for (const legacy of legacySilences) {
      if (start < legacy.endFrame && legacy.startFrame < end) {
        throw new NarrationTextV2Error("用户静默不得与镜头静默（legacy）重叠。");
      }
    }
  }
  return normalized.map(([start, end]) => ({ id: `ns-user-${start}-${end}`, startFrame: start, endFrame: end, source: "user" as const }));
}

// ══ v2 完整计划合同（SND-02：先骨架后实现，红例来自行为断言） ══

export interface NarrationPlanV2 {
  version: "video-factory/narration-plan-v2";
  mode: "continuous_groups";
  script: { sha256: string };
  visualPlan: { sha256: string; fps: 30; totalFrames: number };
  source: { normalization: "narration-text-v1"; sourceContextId: string; canonicalSourceSha256: string };
  edgeTrim: "none";
  subtitleMode: "provider_sentence";
  silences: Array<{ id: string; startFrame: number; endFrame: number; source: "legacy_silent_scene" | "user" }>;
  groups: Array<{
    id: string;
    sourceRange: { baseGroupId: string; startCodePoint: number; endCodePoint: number };
    sourceScenePositions: number[];
    text: string;
    window: { startFrame: number; endFrame: number };
    placement: { anchor: "start" | "end"; offsetFrames: number };
  }>;
}

/** 消费者按此联合显式分派；未知版本不降级（见 narrationPlanVersion）。 */
export type SupportedNarrationPlan = NarrationPlan | NarrationPlanV2;

/**
 * §4.2.2 GET 读回：从保存的 v2 计划反推 segments/userSilences 再走整体校验。
 * 与 Python `validate_narration_plan_v2_standalone` 同语义——反推的选择与原候选产生
 * 同一 build 输入；严格类型/值校验仍由 validateNarrationPlanV2 统一执行。
 */
export function narrationPlanV2StandaloneInput(
  value: unknown,
  base: Omit<NarrationPlanV2BuildInput, "segments" | "userSilences">,
): NarrationPlanV2BuildInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrationTextV2Error("v2 旁白计划必须是对象。");
  }
  const plan = value as NarrationPlanV2;
  if (plan.version !== "video-factory/narration-plan-v2") {
    throw new NarrationTextV2Error("未知旁白计划版本，拒绝降级。");
  }
  if (!Array.isArray(plan.groups)) throw new NarrationTextV2Error("v2 计划分组必须是列表。");
  const segments: NarrationPlanV2BuildInput["segments"] = [];
  const slicesByBaseGroup = new Map<string, NarrationPlanV2BuildInput["segments"][number]["slices"]>();
  for (const group of plan.groups) {
    if (!group || typeof group !== "object") throw new NarrationTextV2Error("v2 计划分组必须是对象。");
    const sourceRange = group.sourceRange;
    if (!sourceRange || typeof sourceRange !== "object") throw new NarrationTextV2Error("v2 计划分组缺少来源范围。");
    const baseGroupId = sourceRange.baseGroupId;
    if (typeof baseGroupId !== "string" || !baseGroupId) throw new NarrationTextV2Error("v2 计划分组来源范围无效。");
    // 同一基础有词区的多段合并为同一组分段选择（与 Python standalone 一致）；
    // 段间顺序/连续性错误由重建期望的逐字段对照拒绝。
    let slices = slicesByBaseGroup.get(baseGroupId);
    if (!slices) {
      slices = [];
      slicesByBaseGroup.set(baseGroupId, slices);
      segments.push({ baseGroupIndex: segments.length, slices });
    }
    const window = group.window;
    const placement = group.placement;
    if (!window || typeof window !== "object" || !placement || typeof placement !== "object") {
      throw new NarrationTextV2Error("v2 计划分组必须有窗口与落点。");
    }
    slices.push({
      start: sourceRange.startCodePoint as number, end: sourceRange.endCodePoint as number,
      window: { startFrame: window.startFrame as number, endFrame: window.endFrame as number },
      placement: { anchor: placement.anchor as "start" | "end", offsetFrames: placement.offsetFrames as number },
    });
  }
  // Python 侧按 (start, end) 排序后重建；bool 等类型错误交给整体校验拒绝。
  for (const segment of segments) {
    segment.slices.sort((a, b) => (a.start as number) - (b.start as number) || (a.end as number) - (b.end as number));
  }
  const userSilences = (Array.isArray(plan.silences) ? plan.silences : [])
    .filter((silence) => silence && typeof silence === "object" && (silence as { source?: unknown }).source === "user")
    .map((silence) => {
      const record = silence as { startFrame: number; endFrame: number };
      return { startFrame: record.startFrame, endFrame: record.endFrame };
    });
  return { ...base, segments, userSilences };
}

export interface NarrationPlanV2BuildInput {
  scenes: Array<{ position: number; narration: string; duration: number }>;
  scriptSha256: string;
  visualSha256: string;
  sourceContextId: string;
  segments: Array<{
    baseGroupIndex: number;
    slices: Array<{
      start: number; end: number;
      window: { startFrame: number; endFrame: number };
      placement: { anchor: "start" | "end"; offsetFrames: number };
    }>;
  }>;
  userSilences: Array<{ startFrame: number; endFrame: number }>;
}

export function buildNarrationPlanV2(input: NarrationPlanV2BuildInput): NarrationPlanV2 {
  if (!input || typeof input !== "object" || !Array.isArray(input.scenes)) {
    throw new NarrationTextV2Error("v2 计划输入必须是带 scenes 的对象。");
  }
  if (typeof input.scriptSha256 !== "string" || typeof input.visualSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(input.scriptSha256) || !/^[a-f0-9]{64}$/.test(input.visualSha256)) {
    throw new NarrationTextV2Error("v2 计划缺少已确认的脚本与画面身份。");
  }
  if (typeof input.sourceContextId !== "string" || !input.sourceContextId.trim() || input.sourceContextId.length > 200) {
    throw new NarrationTextV2Error("v2 计划的 sourceContextId 必须是宿主派生的非空标识。");
  }
  const facts = deriveV2SourceFacts(input.scenes);

  const userSilences = userSilencesV2(facts.totalFrames, facts.legacySilences,
    (Array.isArray(input.userSilences) ? input.userSilences : []).map(
      (silence) => ({ start: silence?.startFrame, end: silence?.endFrame }),
    ));
  for (const silence of userSilences) {
    const inside = facts.baseGroups.some((group) =>
      group.frameRange.startFrame <= silence.startFrame && silence.endFrame <= group.frameRange.endFrame);
    if (!inside) throw new NarrationTextV2Error("用户静默必须落在某一个基础有词区内。");
  }
  const allSilences = [
    ...facts.legacySilences.map((silence) => ({ id: silence.id, startFrame: silence.startFrame, endFrame: silence.endFrame, source: "legacy_silent_scene" as const })),
    ...userSilences.map((silence) => ({ id: silence.id, startFrame: silence.startFrame, endFrame: silence.endFrame, source: "user" as const })),
  ].sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);

  // 每个基础有词区的显式分段选择；未提及的保持连续整段。
  const segmentsByGroup = new Map<number, Array<{ start: number; end: number; window: { startFrame: number; endFrame: number }; placement: { anchor: string; offsetFrames: number } }>>();
  const segments = Array.isArray(input.segments) ? input.segments : [];
  for (const segment of segments) {
    const index = (segment as { baseGroupIndex?: unknown })?.baseGroupIndex;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= facts.baseGroups.length) {
      throw new NarrationTextV2Error("分段所属基础有词区索引无效。");
    }
    if (segmentsByGroup.has(index)) throw new NarrationTextV2Error("每个基础有词区只能有一组分段选择。");
    const slices = (segment as { slices?: unknown })?.slices;
    if (!Array.isArray(slices) || slices.length === 0) throw new NarrationTextV2Error("显式分段不能为空。");
    segmentsByGroup.set(index, slices as Array<{ start: number; end: number; window: { startFrame: number; endFrame: number }; placement: { anchor: string; offsetFrames: number } }>);
  }

  const groups: NarrationPlanV2["groups"] = [];
  let previousEnd: number | null = null;
  for (const [index, baseGroup] of facts.baseGroups.entries()) {
    const explicit = segmentsByGroup.get(index);
    const prepared = explicit ?? [{
      start: 0, end: baseGroup.endCodePoint,
      window: { ...baseGroup.frameRange }, placement: { anchor: "start", offsetFrames: 0 },
    }];
    const slices = validateSlicesV2(baseGroup, prepared.map((item) => ({ start: item.start, end: item.end })));
    for (const [sliceIndex, slice] of slices.entries()) {
      const raw = prepared[sliceIndex]!;
      const start = raw.window?.startFrame;
      const end = raw.window?.endFrame;
      if (typeof start !== "number" || !Number.isSafeInteger(start)
        || typeof end !== "number" || !Number.isSafeInteger(end)) {
        throw new NarrationTextV2Error("分段窗口必须是安全整数帧。");
      }
      if (!(baseGroup.frameRange.startFrame <= start && start < end && end <= baseGroup.frameRange.endFrame)) {
        throw new NarrationTextV2Error("分段窗口必须位于其基础有词区的画面区间内。");
      }
      for (const silence of allSilences) {
        if (start < silence.endFrame && silence.startFrame < end) {
          throw new NarrationTextV2Error("分段窗口不得与显式或镜头静默重叠。");
        }
      }
      if (previousEnd !== null && start < previousEnd) {
        throw new NarrationTextV2Error("分段窗口按文字顺序排列且不得重叠。");
      }
      const anchor = raw.placement?.anchor;
      const offset = raw.placement?.offsetFrames;
      if ((anchor !== "start" && anchor !== "end") || typeof offset !== "number" || !Number.isSafeInteger(offset)
        || offset < 0 || offset >= end - start) {
        throw new NarrationTextV2Error("分段落点必须位于窗口内。");
      }
      previousEnd = end;
      groups.push({
        id: "ng-" + identitySha([baseGroup.baseGroupId, slice.start, slice.end]),
        sourceRange: { baseGroupId: baseGroup.baseGroupId, startCodePoint: slice.start, endCodePoint: slice.end },
        sourceScenePositions: slice.sourceScenePositions,
        text: slice.text,
        window: { startFrame: start, endFrame: end },
        placement: { anchor, offsetFrames: offset },
      });
    }
  }

  return {
    version: "video-factory/narration-plan-v2",
    mode: "continuous_groups",
    script: { sha256: input.scriptSha256 },
    visualPlan: { sha256: input.visualSha256, fps: 30, totalFrames: facts.totalFrames },
    source: { normalization: "narration-text-v1", sourceContextId: input.sourceContextId, canonicalSourceSha256: canonicalSourceSha256V2(facts) },
    edgeTrim: "none",
    subtitleMode: "provider_sentence",
    silences: allSilences,
    groups,
  };
}

const V2_PLAN_KEYS = ["edgeTrim", "groups", "mode", "script", "silences", "source", "subtitleMode", "version", "visualPlan"];
const V2_GROUP_KEYS = ["id", "placement", "sourceRange", "sourceScenePositions", "text", "window"];

/** §4.2.1：候选 v2 数值字段先按整数语义显式校验（先于逐字段对照），与 Python 同判同语义。 */
function validateV2CandidateStructure(value: NarrationPlanV2): void {
  const safeInt = (item: unknown, label: string): number => {
    if (typeof item !== "number" || !Number.isSafeInteger(item)) {
      throw new NarrationTextV2Error(`${label}必须是安全整数。`);
    }
    return item;
  };
  if (typeof value.visualPlan?.fps !== "number" || !Number.isSafeInteger(value.visualPlan.fps) || value.visualPlan.fps !== 30) {
    throw new NarrationTextV2Error("v2 计划画面帧率必须是整数 30。");
  }
  safeInt(value.visualPlan?.totalFrames, "v2 计划总帧数");
  if (!Array.isArray(value.silences)) throw new NarrationTextV2Error("v2 计划静默必须是列表。");
  for (const silence of value.silences) {
    safeInt(silence?.startFrame, "静默起点");
    safeInt(silence?.endFrame, "静默终点");
  }
  if (!Array.isArray(value.groups)) throw new NarrationTextV2Error("v2 计划分组必须是列表。");
  for (const group of value.groups) {
    if (!Array.isArray(group?.sourceScenePositions) || group.sourceScenePositions.some((position) => !Number.isSafeInteger(position))) {
      throw new NarrationTextV2Error("v2 组镜头归属必须是整数位置列表。");
    }
    const range = group?.sourceRange;
    if (typeof range?.baseGroupId !== "string"
      || !Number.isSafeInteger(range.startCodePoint) || !Number.isSafeInteger(range.endCodePoint)) {
      throw new NarrationTextV2Error("v2 组来源范围必须是整数码点区间。");
    }
    const start = safeInt(group?.window?.startFrame, "组窗口起点");
    const end = safeInt(group?.window?.endFrame, "组窗口终点");
    if (start >= end) throw new NarrationTextV2Error("组窗口起点必须严格小于终点。");
    safeInt(group?.placement?.offsetFrames, "组落点偏移");
  }
}

export function validateNarrationPlanV2(value: unknown, expected: NarrationPlanV2BuildInput): NarrationPlanV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrationTextV2Error("v2 旁白计划必须是对象。");
  }
  const candidate = value as NarrationPlanV2;
  if (candidate.version !== "video-factory/narration-plan-v2") {
    throw new NarrationTextV2Error("未知旁白计划版本，拒绝降级。");
  }
  validateV2CandidateStructure(candidate);
  const expectedPlan = buildNarrationPlanV2(expected);
  if (!isDeepStrictEqual(Object.keys(candidate).sort(), V2_PLAN_KEYS)) {
    throw new NarrationTextV2Error("v2 计划字段与合同不符。");
  }
  for (const key of ["mode", "edgeTrim", "subtitleMode", "script", "visualPlan", "source", "silences"] as const) {
    if (!isDeepStrictEqual(candidate[key], expectedPlan[key])) {
      throw new NarrationTextV2Error("v2 计划的已确认来源身份或静默与期望不一致。");
    }
  }
  if (!Array.isArray(candidate.groups) || candidate.groups.length !== expectedPlan.groups.length) {
    throw new NarrationTextV2Error("v2 计划分组与已确认来源不一致。");
  }
  for (const [index, group] of candidate.groups.entries()) {
    const original = expectedPlan.groups[index]!;
    if (!group || typeof group !== "object" || !isDeepStrictEqual(Object.keys(group).sort(), V2_GROUP_KEYS)) {
      throw new NarrationTextV2Error("v2 计划分组字段与合同不符。");
    }
    if (group.id !== original.id) throw new NarrationTextV2Error("v2 组身份与来源范围不一致。");
    if (!isDeepStrictEqual(group.sourceRange, original.sourceRange)) throw new NarrationTextV2Error("v2 组来源范围与已确认文字不一致。");
    if (!isDeepStrictEqual(group.sourceScenePositions, original.sourceScenePositions)) throw new NarrationTextV2Error("v2 组镜头归属与已确认文字不一致。");
    if (group.text !== original.text) throw new NarrationTextV2Error("v2 组文字必须等于其来源范围切片，改词请回脚本。");
    if (!isDeepStrictEqual(group.window, original.window)) throw new NarrationTextV2Error("v2 组窗口必须与已确认选择一致。");
    if (!isDeepStrictEqual(group.placement, original.placement)) throw new NarrationTextV2Error("v2 组落点必须与已确认选择一致。");
  }
  return structuredClone(candidate);
}

/** 消费者入口按版本显式分派；未知版本一律拒绝，不静默降级到 v1。 */
export function narrationPlanVersion(value: unknown): "video-factory/narration-plan-v1" | "video-factory/narration-plan-v2" {
  const version = (value as { version?: unknown } | null | undefined)?.version;
  if (version === "video-factory/narration-plan-v1" || version === "video-factory/narration-plan-v2") return version;
  throw new NarrationTextV2Error("未知旁白计划版本，拒绝降级。");
}

// ══ §2.2 候选预览与采用（S2）：固定 DTO 与纯函数部分 ══

export interface NarrationCandidate {
  version: "video-factory/narration-plan-v2";
  groups: Array<{
    sourceRange: { baseGroupId: string; startCodePoint: number; endCodePoint: number };
    window: { startFrame: number; endFrame: number };
    placement: { anchor: "start" | "end"; offsetFrames: number };
  }>;
  userSilences: Array<{ startFrame: number; endFrame: number }>;
}

/** 候选不含 text/scene 列表/音色/费率：文字与归属一律由服务端派生。 */
export function parseNarrationCandidate(value: unknown): NarrationCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NarrationTextV2Error("旁白候选必须是对象。");
  }
  const candidate = value as NarrationCandidate;
  if (candidate.version !== "video-factory/narration-plan-v2") {
    throw new NarrationTextV2Error("旁白候选版本未知，拒绝降级。");
  }
  if (!Array.isArray(candidate.groups)) throw new NarrationTextV2Error("旁白候选分段必须是列表。");
  for (const group of candidate.groups) {
    const range = (group as NarrationCandidate["groups"][number])?.sourceRange;
    const window = (group as NarrationCandidate["groups"][number])?.window;
    const placement = (group as NarrationCandidate["groups"][number])?.placement;
    if (typeof range?.baseGroupId !== "string" || !/^nb-[a-f0-9]{64}$/.test(range.baseGroupId)
      || !Number.isSafeInteger(range.startCodePoint) || !Number.isSafeInteger(range.endCodePoint)
      || !Number.isSafeInteger(window?.startFrame) || !Number.isSafeInteger(window?.endFrame)
      || (placement?.anchor !== "start" && placement?.anchor !== "end")
      || !Number.isSafeInteger(placement?.offsetFrames)) {
      throw new NarrationTextV2Error("旁白候选分段字段不完整或类型错误。");
    }
  }
  if (!Array.isArray(candidate.userSilences)) throw new NarrationTextV2Error("旁白候选静默必须是列表。");
  for (const silence of candidate.userSilences) {
    if (!Number.isSafeInteger(silence?.startFrame) || !Number.isSafeInteger(silence?.endFrame)) {
      throw new NarrationTextV2Error("旁白候选静默必须是整数帧区间。");
    }
  }
  return structuredClone(candidate);
}

const safeId = (value: unknown, label: string, maximum = 100): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || !/^[A-Za-z0-9_.:@-]+$/.test(value)) {
    throw new NarrationTextV2Error(`${label}必须是宿主可核对的非空标识。`);
  }
  return value;
};

export function narrationEditorSessionId(value: unknown): string {
  return safeId(value, "编辑会话身份");
}

export function narrationRequestId(value: unknown): string {
  return safeId(value, "请求身份");
}

export function narrationTicketId(value: unknown): string {
  if (typeof value !== "string" || !/^npt-[A-Za-z0-9_-]{1,80}$/.test(value)) {
    throw new NarrationTextV2Error("预览票据身份无效。");
  }
  return value;
}

export function narrationEditSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new NarrationTextV2Error("编辑代次必须是非负安全整数。");
  }
  return value;
}

/** 候选内容身份：由规范 JSON 摘要派生，请求与票据绑定同一候选。 */
export function candidateIdV2(candidate: NarrationCandidate): string {
  return "nc-" + identitySha(candidate);
}

/** 待保存计划的规范 JSON 字节 SHA（区别于文件 pretty JSON 的字节）。 */
export function planCanonicalSha256V2(plan: NarrationPlanV2): string {
  return createHash("sha256").update(canonicalJsonV2(plan), "utf8").digest("hex");
}

/** 候选 → buildNarrationPlanV2 输入：按基础有词区分组（组内按文字顺序），未提及的保持隐式整段。 */
export function candidateToBuildInput(
  input: Omit<NarrationPlanV2BuildInput, "segments" | "userSilences">,
  candidate: NarrationCandidate,
): NarrationPlanV2BuildInput {
  const facts = deriveV2SourceFacts(input.scenes);
  const indexByBaseGroup = new Map(facts.baseGroups.map((group, index) => [group.baseGroupId, index]));
  const segments = new Map<number, Array<{ start: number; end: number; window: { startFrame: number; endFrame: number }; placement: { anchor: "start" | "end"; offsetFrames: number } }>>();
  for (const group of candidate.groups) {
    const index = indexByBaseGroup.get(group.sourceRange.baseGroupId);
    if (index === undefined) throw new NarrationTextV2Error("旁白候选引用了不属于当前原稿的基础有词区。");
    if (!segments.has(index)) segments.set(index, []);
    segments.get(index)!.push({
      start: group.sourceRange.startCodePoint, end: group.sourceRange.endCodePoint,
      window: group.window, placement: group.placement,
    });
  }
  return {
    ...input,
    segments: [...segments.entries()].map(([baseGroupIndex, slices]) => ({ baseGroupIndex, slices }))
      .sort((a, b) => a.baseGroupIndex - b.baseGroupIndex),
    userSilences: candidate.userSilences.map((silence) => ({ startFrame: silence.startFrame, endFrame: silence.endFrame })),
  };
}

/** 从服务端有效源 + 用户候选派生完整 v2 计划；候选未提及的基础有词区保持连续整段。 */
export function buildNarrationPlanV2FromCandidate(
  input: Omit<NarrationPlanV2BuildInput, "segments" | "userSilences">,
  candidate: NarrationCandidate,
): NarrationPlanV2 {
  return buildNarrationPlanV2(candidateToBuildInput(input, candidate));
}

export const NARRATION_PREVIEW_TICKET_VERSION = "video-factory/narration-preview-ticket-v1";
export const NARRATION_CONFIRM_RECEIPT_VERSION = "video-factory/narration-confirm-receipt-v1";

export interface NarrationPreviewQuoteV2 {
  status: "estimated" | "unavailable";
  source: "configured_rate";
  estimatedCostCny?: number;
  maxCostCny?: number;
  unitPriceCny?: string;
  items?: Array<{ groupId: string; estimatedUnits: number; maxCostCny: number; reused: boolean }>;
}

export interface NarrationPreviewTicketResponseV2 {
  expectedRunRevision: number;
  sourceContextId: string;
  editorSessionId: string;
  editSequence: number;
  candidateId: string;
  ticketId: string;
  plan: NarrationPlanV2;
  planSha256: string;
  providerConfigDigest: string;
  quote: NarrationPreviewQuoteV2;
}

export interface NarrationConfirmReceiptV2 {
  accepted: true;
  requestId: string;
  planSha256: string;
  artifactId: string;
  inputVersionId: string;
  expectedRunRevision: number;
  resultingRunRevision: number;
  replay: boolean;
  /** §4.2.3：该保存的输入版本是否仍是 voice 当前有效版本（历史重放为 false，不回滚）。 */
  current?: boolean;
}
