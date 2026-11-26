import { lazy, Suspense, useEffect, useState, type CSSProperties } from "react";
import type {
  ArtifactHead, ArtifactRevision, AudioSummary, Bootstrap, ContentSource, CreativeProjectContent,
  FileContent, InputRef, MediaContent, ModelBinding, OperationSpec, Proposal, ProposalModelLabel,
  RebindProposal, RenderFitMode, RenderParameters, Run, Work,
} from "../../shared/agent/generated/contracts.js";
import { projectFileMime } from "../../shared/agent/project-files.js";
import { AudioSummaryView, MediaSourceDetails } from "./AudioSummaryView.js";
import { blobUrl } from "./review-content.js";
import { RevisionExports } from "./RevisionExports.js";
import { MarkdownBody } from "./markdown.js";

import { subtitleDownloadUrl, type ReviewBuffers } from "./review-edits.js";
import type { RevisionRef } from "../../shared/agent/generated/contracts.js";
const SubtitleTrackPanel = lazy(() => import("./SubtitleTrackPanel.js").then(module => ({ default: module.SubtitleTrackPanel })));

export const runEnded = (state: Run["state"]) => ["succeeded", "failed", "cancelled"].includes(state);
const money = (amount: number) => `¥${(amount / 100).toFixed(2)}`;

const PROPOSAL_STATE_LABEL = {
  ready: "待确认", stale: "需重新准备", expired: "已过期", accepted: "已受理",
} as const;

const RUN_STATE_LABEL = {
  queued: "等待制作", running: "后台制作中", unknown: "结果待核实", cancel_requested: "正在确认取消",
  succeeded: "已完成", failed: "未完成", cancelled: "已停止",
} as const;

const KINDS = { video: "视频", image: "图片", speech: "配音", render: "合成" };
const FIT_LABEL = { contain_pad: "完整画面留边", cover_crop: "居中裁切", blur_backdrop: "模糊背景" } satisfies Record<RenderFitMode, string>;
const MOTION_LABEL = { zoom_in: "推近", zoom_out: "拉远", pan: "平移" };
const OP_STATE_LABEL = { pending: "等待中", running: "进行中", succeeded: "已完成", failed: "未完成", cancelled: "已停止" } as const;

// 步骤命名与冻结规格同序：同 kind 依次编号（如“视频 2”），与 HTTP/SSE/read_run 同一事实。
function operationLabel(operation: Run["operations"][number], all: Run["operations"]): string {
  const peers = all.filter(item => item.kind === operation.kind);
  return peers.length > 1 ? `${KINDS[operation.kind]} ${peers.indexOf(operation) + 1}` : KINDS[operation.kind];
}
type RevisionCache = Record<string, ArtifactRevision>;
interface ScopeProps {
  artifacts?: ArtifactHead[] | undefined;
  revisions?: RevisionCache | undefined;
  works?: Work[] | undefined;
  onOpen?: ((id: string, revisionId: string) => void) | undefined;
}

// 交付位置一行（B6）：existing 从当前作品投影读组/事项标签，create 按声明读；不露原始 ID。
// 目标已不存在时返回 null，可否受理仍由服务端 blocker 说明。
function outputTargetLabel(spec: Proposal["spec"], works: Work[]): string | null {
  const declared = "outputTarget" in spec ? spec.outputTarget ?? null : null;
  if (!declared) return null;
  if (declared.group.mode === "existing") {
    const groupId = declared.group.groupId;
    const group = works.find(work => work.id === spec.workId)?.reviewGroups.find(group => group.id === groupId);
    if (!group) return null;
    if (declared.item.mode === "existing") {
      const itemId = declared.item.itemId;
      const item = group.items.find(item => item.id === itemId);
      return item ? `${group.title} · ${item.label}` : null;
    }
    return `${group.title} · ${declared.item.label}`;
  }
  return `${declared.group.title} · ${declared.item.label}`;
}

function revisionLabel(ref: { artifactId: string; revisionId: string }, artifacts: ArtifactHead[], revisions: RevisionCache): string {
  const artifact = artifacts.find(item => item.id === ref.artifactId);
  const revision = revisions[`${ref.artifactId}:${ref.revisionId}`];
  const number = revision?.revisionNumber ?? (artifact?.revisionId === ref.revisionId ? artifact.revisionNumber : null);
  return `${artifact?.title ?? "已选内容"} · ${number ? `v${number}` : "绑定修订待读取"}`;
}
// final render 的视觉槽位：ordered 按 inputs；narrated 按 videoInputSlots；timed/mixed 按 segments。
// code_project 从冻结工程解析，不走输入槽；音乐/配音不计作画面；同一源文件两次引用仍是两个时间线片段。
function finalVisualInputs(spec: Proposal["spec"]): InputRef[] {
  const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
  if (final?.kind !== "render" || final.parameters.assembly === "code_project") return [];
  const parameters = final.parameters;
  const slots = parameters.assembly === "narrated_concat" ? parameters.videoInputSlots
    : parameters.assembly === "timed_narrated_concat" || parameters.assembly === "mixed_concat" ? parameters.segments.map(segment => segment.inputSlot)
    : final.inputs.map((_, index) => index);
  return slots.map(slot => final.inputs[slot]).filter((ref): ref is InputRef => ref != null && ref.kind !== "text");
}

function inputLabel(ref: InputRef, spec: Proposal["spec"], artifacts: ArtifactHead[], revisions: RevisionCache): string {
  if (ref.kind === "text") return ref.text;
  if (ref.kind === "artifact_revision") {
    // final 视觉槽上的媒体修订也是保留输入（E3）：标签同样标出，与 blob 一致。
    const kept = finalVisualInputs(spec).some(item => item.kind === "artifact_revision"
      && item.artifactId === ref.artifactId && item.revisionId === ref.revisionId);
    return `${kept ? "保留 · " : ""}${revisionLabel(ref, artifacts, revisions)}`;
  }
  if (ref.kind === "operation_output") {
    const op = spec.operations.find(item => item.operationId === ref.producerOperationId);
    const peers = spec.operations.filter(item => item.kind === op?.kind);
    return `${specReusesMedia(spec) ? "重做 · " : ""}本次${op ? KINDS[op.kind] : "生成"}${peers.length > 1 ? ` ${peers.indexOf(op!) + 1}` : ""}产出`;
  }
  if (ref.kind === "project_revision") return `保留 · 工程 · ${revisionLabel(ref.projectRevision, artifacts, revisions)}`;
  const blobs = spec.operations.flatMap(op => op.inputs).filter(input => input.kind === "blob");
  const ids = [...new Set(blobs.map(input => input.kind === "blob" ? input.blobId : null))];
  return `保留 · 已有素材 ${ids.indexOf(ref.blobId) + 1}`;
}

function renderNarrationInput(op: Extract<OperationSpec, { kind: "render" }>): InputRef | undefined {
  const parameters = op.parameters;
  const slot = parameters.assembly === "mixed_concat" ? parameters.narration?.inputSlot
    : parameters.assembly === "ordered_concat" || parameters.assembly === "code_project" ? undefined : parameters.narrationInputSlot;
  return slot === undefined ? undefined : op.inputs[slot];
}

// 只按冻结规格区分本次生成与已有媒体，不从客户端递归推导声音内容。
const specReusesMedia = (spec: Proposal["spec"]) => {
  const final = spec.operations.find(op => op.operationId === spec.finalOutput.operationId);
  const narration = final?.kind === "render" ? renderNarrationInput(final) : undefined;
  return finalVisualInputs(spec).some(ref => ref.kind === "blob" || ref.kind === "artifact_revision" || ref.kind === "project_revision")
    || narration?.kind === "blob" || narration?.kind === "artifact_revision" || narration?.kind === "project_revision";
};
function renderSummary(parameters: RenderParameters): string {
  if (parameters.assembly === "code_project") return `工程渲染 · ${parameters.expectedMediaKind === "video"
    ? `${parameters.width}×${parameters.height} · ${parameters.fps} fps · MP4`
    : parameters.expectedMediaKind === "image" ? `${parameters.width}×${parameters.height} · ${parameters.format.toUpperCase()}`
    : `${parameters.sampleRate} Hz · ${parameters.channels} 声道 · ${parameters.format.toUpperCase()}`}`;
  return `${parameters.width}×${parameters.height} · ${parameters.fps} fps · MP4 · ${
    parameters.assembly === "ordered_concat"
      ? `顺序拼接 · ${parameters.audioMode === "preserve" ? "保留镜头原声" : "全片静音"}`
      : parameters.assembly === "mixed_concat" ? "画面与声音混合成片"
      : `${parameters.assembly === "narrated_concat" ? "旁白成片" : "旁白定时成片"} · 旁白替换原声`}`;
}
function operationSummary(op: OperationSpec): string {
  if (op.kind === "video") return `${op.parameters.durationSeconds} 秒 · ${op.parameters.aspectRatio} · ${op.parameters.resolution} · ${op.parameters.audioMode === "none" ? "无声" : "原生音频"}`;
  if (op.kind === "render") return renderSummary(op.parameters);
  if (op.kind === "image") return `${op.parameters.aspectRatio} · ${op.parameters.resolution}`;
  return `${op.parameters.voiceId} · ${op.parameters.format}`;
}

function canvasLabel(parameters: Exclude<RenderParameters, { assembly: "code_project" }>): string {
  let a = parameters.width, b = parameters.height;
  while (b) [a, b] = [b, a % b];
  return `${parameters.width / a}:${parameters.height / a} · ${parameters.width}×${parameters.height} · ${parameters.fps} fps · ${FIT_LABEL[parameters.fitMode ?? "contain_pad"]}`;
}

// 逐镜覆盖只放在相应镜头之后，成片通用画幅在提案开头展示。
function renderSegmentLabel(segment: Extract<RenderParameters, { assembly: "timed_narrated_concat" | "mixed_concat" }>["segments"][number]): string {
  const timing = segment.kind === "video"
    ? `视频 ${(segment.startMs / 1000).toFixed(1)}s 起 ${(segment.durationMs / 1000).toFixed(1)}s`
    : `静帧 ${(segment.durationMs / 1000).toFixed(1)}s`;
  const motion = segment.kind === "image" && segment.kenBurns && segment.kenBurns !== "none" ? MOTION_LABEL[segment.kenBurns] : null;
  return [timing, segment.fitMode && FIT_LABEL[segment.fitMode], motion].filter(Boolean).join(" · ");
}

function slotFitLabel(parameters: RenderParameters, slot: number): string {
  if (parameters.assembly !== "ordered_concat" && parameters.assembly !== "narrated_concat") return "";
  const style = parameters.visualStyles?.find(item => item.inputSlot === slot);
  return style ? ` · ${FIT_LABEL[style.fitMode]}` : "";
}

function VideoAnchors({ spec, works, artifacts, revisions, onOpen }: {
  spec: Proposal["spec"]; works: Work[]; artifacts: ArtifactHead[]; revisions: RevisionCache; onOpen: ScopeProps["onOpen"];
}) {
  const videos = spec.operations.filter(op => op.kind === "video");
  const groups = works.find(work => work.id === spec.workId)?.reviewGroups;
  return videos.map((op, index) => {
    const { firstFrameSlot, lastFrameSlot, referenceImageSlots } = op.parameters;
    const anchors: { label: string; slot: number }[] = [];
    if (firstFrameSlot !== undefined) anchors.push({ label: "首帧参考", slot: firstFrameSlot });
    if (lastFrameSlot !== undefined) anchors.push({ label: "尾帧参考", slot: lastFrameSlot });
    for (const slot of referenceImageSlots ?? []) anchors.push({ label: "参考图", slot });
    if (!anchors.length) return null;
    return <div className="agent-video-anchors" key={op.operationId} role="group" aria-label={`镜头 ${index + 1} 参考图`}>
      {videos.length > 1 ? <strong>镜头 {index + 1}</strong> : null}
      {anchors.map(({ slot, label }) => {
        const source = op.inputs[slot]!;
        const key = `${label}:${slot}`;
        if (source.kind === "artifact_revision") {
          const revision = revisions[`${source.artifactId}:${source.revisionId}`];
          const head = artifacts.find(artifact => artifact.id === source.artifactId);
          const version = revision?.revisionNumber ?? (head?.revisionId === source.revisionId ? head.revisionNumber : null);
          const matches = (ref: ContentSource | null) => ref?.kind === "artifact_revision" && ref.artifactId === source.artifactId && ref.revisionId === source.revisionId;
          const frozen = "reviewInputs" in spec ? spec.reviewInputs.filter(input => matches(input.source)) : [];
          const candidates = groups?.flatMap(group => group.items.filter(item => frozen.length
            ? frozen.some(input => input.groupId === group.id && input.itemId === item.id)
            : matches(item.approved) || matches(item.draft)));
          const item = candidates?.length === 1 ? candidates[0] : undefined;
          const roleLabel = label === "参考图" && item?.role === "character" ? "角色参考" : label === "参考图" && item?.role === "scene" ? "场景参考" : label;
          const content = revision?.content;
          const thumb = content?.format === "media" && content.mimeType.startsWith("image/") ? blobUrl(content.blobId) : null;
          const caption = `${roleLabel}：${item?.label ?? head?.title ?? "图片"} · ${version === null ? "绑定修订待读取" : `v${version}`}`;
          return <button type="button" key={key} disabled={!onOpen} onClick={() => onOpen?.(source.artifactId, source.revisionId)}>
            {thumb ? <img src={thumb} alt="" loading="lazy" /> : null}<span>{caption}</span>
          </button>;
        }
        return <span key={key}>{source.kind === "blob" ? <img src={blobUrl(source.blobId)} alt="" loading="lazy" /> : null}
          <span>{label}：{inputLabel(source, spec, artifacts, revisions)}</span></span>;
      })}
    </div>;
  });
}

type MediaKind = "image" | "video" | "speech";
type MediaOperationSpec = Exclude<OperationSpec, { kind: "render" }>;
type PoolModelEntry = Bootstrap["models"][number];

const MEDIA_KIND_ORDER: readonly MediaKind[] = ["video", "image", "speech"];

function sameBinding(a: ModelBinding | null | undefined, b: ModelBinding | null | undefined): boolean {
  if (!a || !b) return false;
  return a.providerId === b.providerId
    && a.modelId === b.modelId
    && a.connectionId === b.connectionId
    && a.configurationRevisionId === b.configurationRevisionId;
}

function modelLabelOf(
  binding: ModelBinding | null | undefined,
  spec: Proposal["spec"],
  poolModels: readonly PoolModelEntry[],
): { connectionName: string; modelName: string; full: string; costSummary?: string; externalUnit?: ProposalModelLabel["externalUnit"]; defaultVoiceId?: string } {
  if (!binding) return { connectionName: "", modelName: "未选定模型", full: "未选定模型" };
  const fromSpec = "modelLabels" in spec
    ? spec.modelLabels?.find(item => item.configurationRevisionId === binding.configurationRevisionId)
    : undefined;
  const fromPool = poolModels.find(item => sameBinding(item.binding, binding));
  const connectionName = fromSpec?.connectionName ?? fromPool?.connectionName ?? (
    binding.providerId === "ark" ? "火山方舟"
      : binding.providerId === "colab" ? "Google Colab"
      : binding.providerId === "minimax" ? "MiniMax"
      : binding.providerId === "wan" ? "万相"
      : binding.providerId === "openai" ? "OpenAI"
      : binding.providerId === "edge-tts" ? "免费服务"
      : binding.providerId
  );
  const modelName = fromSpec?.modelName ?? fromPool?.name ?? binding.modelId;
  const costSummary = fromSpec?.costSummary ?? fromPool?.costSummary;
  const externalUnit = fromSpec?.externalUnit ?? fromPool?.externalUnit;
  const defaultVoiceId = fromSpec?.defaultVoiceId ?? fromPool?.defaultVoiceId;
  return {
    connectionName,
    modelName,
    full: connectionName ? `${connectionName} · ${modelName}` : modelName,
    ...(costSummary !== undefined ? { costSummary } : {}),
    ...(externalUnit !== undefined ? { externalUnit } : {}),
    ...(defaultVoiceId !== undefined ? { defaultVoiceId } : {}),
  };
}

function voiceLabelOf(voiceId: string, binding: ModelBinding, poolModels: readonly PoolModelEntry[]): string {
  const poolEntry = poolModels.find(item => sameBinding(item.binding, binding));
  const matched = poolEntry?.voices?.find(v => v.id === voiceId);
  if (matched) return matched.label;
  const fallbackLabels: Record<string, string> = {
    "Chinese (Mandarin)_Gentleman": "温润男声 · 普通话",
    "Chinese (Mandarin)_News_Anchor": "新闻女声 · 普通话",
    "Chinese (Mandarin)_Warm_Bestie": "温暖女声 · 普通话",
    "Chinese (Mandarin)_Radio_Host": "电台男声 · 普通话",
    "zh-CN-XiaoxiaoNeural": "晓晓 · 中文女声",
    "zh-CN-YunxiNeural": "云希 · 中文男声",
    "zh-CN-YunyangNeural": "云扬 · 新闻播报",
    "zh-CN-XiaoyiNeural": "晓伊 · 活泼女声",
    "en-US-AriaNeural": "Aria · 英文女声",
    "en-US-GuyNeural": "Guy · 英文男声",
    marin: "Marin · 自然声线",
  };
  return fallbackLabels[voiceId] ?? voiceId;
}

function operationCompatibilityReason(entry: PoolModelEntry, op: MediaOperationSpec): string | null {
  if (entry.availability !== "configured") return "尚未完成配置";
  if (op.kind === "speech" && op.parameters.rate && op.parameters.rate !== "+0%" && entry.binding.providerId !== "edge-tts") {
    return "自定义语速仅 Edge 免费配音支持 — 请回对话调整";
  }
  const cap = entry.capabilitySummary;
  if (!cap) return null;
  if (op.kind === "video") {
    const p = op.parameters;
    if (cap.requiresFirstFrame && p.firstFrameSlot === undefined) {
      return "需单张首帧图 — 请回对话上传或审阅分镜";
    }
    if (cap.supportsReferenceImages === false && (p.referenceImageSlots?.length || p.lastFrameSlot !== undefined)) {
      return "不支持尾帧或多参考图 — 请回对话调整";
    }
    if (cap.durationSecondsMin !== undefined && cap.durationSecondsMax !== undefined) {
      if (p.durationSeconds < cap.durationSecondsMin || p.durationSeconds > cap.durationSecondsMax) {
        const range = cap.durationSecondsMin === cap.durationSecondsMax
          ? `固定 ${cap.durationSecondsMin}s`
          : `${cap.durationSecondsMin}–${cap.durationSecondsMax}s`;
        return `仅支持 ${range}（当前 ${p.durationSeconds}s）— 请回对话调整`;
      }
    }
    if (cap.resolutions?.length) {
      const normalized = p.resolution.toLowerCase();
      const allowed = cap.resolutions.map(r => r.toLowerCase());
      if (!allowed.includes(normalized)) {
        return `需 ${cap.resolutions.join("/")}（当前 ${p.resolution}）— 请回对话调整`;
      }
    }
    if (cap.aspectRatios?.length && !cap.aspectRatios.includes(p.aspectRatio)) {
      return `不支持 ${p.aspectRatio} 画幅 — 请回对话调整`;
    }
    if (cap.audioModes?.length && !cap.audioModes.includes(p.audioMode)) {
      return `仅支持${cap.audioModes.includes("native") ? "原生音画" : "静音"} — 请回对话调整`;
    }
  }
  if (op.kind === "image" && cap.aspectRatios?.length && !cap.aspectRatios.includes(op.parameters.aspectRatio)) {
    return `不支持 ${op.parameters.aspectRatio} 画幅 — 请回对话调整`;
  }
  return null;
}

function batchCompatibilityReason(entry: PoolModelEntry, ops: readonly MediaOperationSpec[]): string | null {
  for (const op of ops) {
    const reason = operationCompatibilityReason(entry, op);
    if (reason) return reason;
  }
  return null;
}

// 多镜头平局时（如双镜头单改第 1 镜为 1:1），优先把未被卡片单独覆盖（非 card_selected）或匹配原默认的修订判为主选。
function choosePrimaryRevision(
  ops: readonly MediaOperationSpec[],
  selectionSources: ReadonlyMap<string, string>,
  defaultBinding: ModelBinding | null | undefined,
): string {
  const stats = new Map<string, { count: number; nonOverridden: number; isDefault: number }>();
  for (const op of ops) {
    const rev = op.model.configurationRevisionId;
    const prev = stats.get(rev) ?? { count: 0, nonOverridden: 0, isDefault: defaultBinding && sameBinding(op.model, defaultBinding) ? 1 : 0 };
    prev.count += 1;
    if (selectionSources.get(op.operationId) !== "card_selected") prev.nonOverridden += 1;
    stats.set(rev, prev);
  }
  return [...stats.entries()].sort((a, b) =>
    b[1].count - a[1].count
    || b[1].nonOverridden - a[1].nonOverridden
    || b[1].isDefault - a[1].isDefault,
  )[0]![0];
}

function operationDisplayName(op: OperationSpec, all: readonly OperationSpec[], reuses: boolean): string {
  if (op.kind === "render") return reuses ? "重新合成" : KINDS.render;
  const peers = all.filter(item => item.kind === op.kind);
  return peers.length > 1 ? `${KINDS[op.kind]} ${peers.indexOf(op) + 1}` : KINDS[op.kind];
}

function ModelPoolSelect({
  id,
  label,
  currentBinding,
  isPendingSelection,
  defaultBinding,
  poolOptions,
  targetOps,
  disabled,
  spec,
  allPoolModels,
  onSelect,
}: {
  id: string;
  label: string;
  currentBinding: ModelBinding | null;
  isPendingSelection: boolean;
  defaultBinding: ModelBinding | null | undefined;
  poolOptions: readonly PoolModelEntry[];
  targetOps: readonly MediaOperationSpec[];
  disabled: boolean;
  spec: Proposal["spec"];
  allPoolModels: readonly PoolModelEntry[];
  onSelect: (entry: PoolModelEntry) => void;
}) {
  const currentInPool = currentBinding ? poolOptions.some(item => sameBinding(item.binding, currentBinding)) : false;
  const selectValue = isPendingSelection || !currentBinding ? "" : currentBinding.configurationRevisionId;
  const currentLabel = modelLabelOf(currentBinding, spec, allPoolModels);
  return <label className="agent-pool-select-field" htmlFor={id}>
    <span>{label}</span>
    <select
      id={id}
      aria-label={label}
      value={selectValue}
      disabled={disabled || poolOptions.length === 0}
      onChange={event => {
        const chosen = poolOptions.find(item => item.binding.configurationRevisionId === event.target.value);
        if (chosen) onSelect(chosen);
      }}
    >
      {isPendingSelection ? <option value="" disabled>请选择本次使用的模型…</option> : null}
      {!isPendingSelection && currentBinding && !currentInPool ? (
        <option value={currentBinding.configurationRevisionId} disabled>
          {currentLabel.full}（已停用 · 请改选可用模型）
        </option>
      ) : null}
      {poolOptions.map(entry => {
        const reason = batchCompatibilityReason(entry, targetOps);
        const isDef = defaultBinding ? sameBinding(entry.binding, defaultBinding) : entry.isDefault;
        const connPrefix = entry.connectionName ? `${entry.connectionName} · ` : "";
        const costSuffix = entry.costSummary ? ` · ${entry.costSummary}` : "";
        const badgeSuffix = isDef ? " [默认]" : "";
        return (
          <option
            key={entry.binding.configurationRevisionId}
            value={entry.binding.configurationRevisionId}
            disabled={Boolean(reason)}
          >
            {connPrefix}{entry.name}{costSuffix}{badgeSuffix}{reason ? `（不可用：${reason}）` : ""}
          </option>
        );
      })}
    </select>
  </label>;
}

function ProposalScope({
  spec,
  audioSummary,
  artifacts = [],
  revisions = {},
  works = [],
  onOpen,
  canEditModels = false,
  rebinding = false,
  poolModels = [],
  onRebindOperation,
}: ScopeProps & {
  spec: Proposal["spec"];
  audioSummary?: AudioSummary | undefined;
  canEditModels?: boolean;
  rebinding?: boolean;
  poolModels?: readonly PoolModelEntry[];
  onRebindOperation?: ((op: MediaOperationSpec, model: ModelBinding, voiceId?: string) => void) | undefined;
}) {
  const final = spec.operations.find(item => item.operationId === spec.finalOutput.operationId);
  const [scopeOpen, setScopeOpen] = useState(false);
  const reuses = specReusesMedia(spec);
  const targetLine = outputTargetLabel(spec, works);
  const defaultsMap = "defaultsAtPrepare" in spec ? spec.defaultsAtPrepare : undefined;
  const sourceMap = new Map(
    ("selectionSources" in spec ? spec.selectionSources ?? [] : []).map(item => [item.operationId, item.source]),
  );
  // 保留/重做摘要（B4/E3）：只统计 final render 的视觉输入与旁白，从冻结规格直接数出来。
  let keptLine: string | null = null;
  if (final?.kind === "render" && reuses && final.parameters.assembly !== "code_project") {
    const visual = finalVisualInputs(spec);
    const kept = visual.filter(ref => ref.kind !== "operation_output").length;
    const redone = visual.length - kept;
    const narration = renderNarrationInput(final);
    const parts = [`保留 ${kept} 段`, `重做 ${redone} 段`];
    if (narration && narration.kind !== "text") parts.push(final.parameters.assembly === "mixed_concat"
      ? narration.kind === "operation_output" ? "新配音" : "复用配音"
      : narration.kind === "operation_output" ? "重做旁白" : "复用旁白");
    if (final.parameters.assembly === "mixed_concat") parts.push("本地重合成");
    keptLine = parts.join(" · ");
  }
  return <>
    <p className="agent-proposal-final">最终产出：{final?.kind === "render"
      ? final.parameters.assembly === "code_project" ? `工程产出${reuses ? " · 重新渲染" : ""}`
      : `视频成片${reuses ? " · 重新合成" : ""}` : final ? KINDS[final.kind] : "作品"}</p>
    {final?.kind === "render" && final.parameters.assembly !== "code_project" ? <p className="agent-operation-order">{canvasLabel(final.parameters)}</p> : null}
    {targetLine ? <p className="agent-operation-order">交付到：{targetLine}</p> : null}
    <VideoAnchors spec={spec} works={works} artifacts={artifacts} revisions={revisions} onOpen={onOpen} />
    {keptLine ? <p className="agent-operation-order">{keptLine}</p> : null}
    {audioSummary ? <AudioSummaryView summary={audioSummary} />
      : final?.kind === "render" && final.parameters.assembly === "code_project" ? null
      : final?.kind === "render" && final.parameters.assembly === "mixed_concat" ? <p className="agent-model-note">本次声音摘要暂不可读。</p>
      : final?.kind === "render" ? <p className="agent-operation-order">声音：{final.parameters.assembly === "ordered_concat"
        ? final.parameters.audioMode === "preserve" ? "保留镜头原声，无音轨片段补等长静音" : "全片静音，不保留镜头原声"
        : final.parameters.assembly === "timed_narrated_concat" ? "旁白替换原声；旁白不足补静音，超出画面时长则不生成"
        : "旁白替换原声；保留完整内容，必要时停留尾帧或补静音"}</p>
      : final?.kind === "video" ? <p className="agent-operation-order">声音：{final.parameters.audioMode === "native" ? "原生音频" : "全片静音"}</p> : null}
    {spec.operations.filter(op => op.kind === "render").map(op => <p className="agent-operation-order" key={op.operationId}>
      {op.parameters.assembly === "code_project" ? <>工程渲染：输出 {op.parameters.outputPath} · {op.parameters.expectedMediaKind === "video" ? "视频" : op.parameters.expectedMediaKind === "image" ? "图片" : "音频"}</>
        : op.parameters.assembly === "mixed_concat" || op.parameters.assembly === "timed_narrated_concat"
        ? <>镜头顺序：{op.parameters.segments.map(segment =>
          `${renderSegmentLabel(segment)}（${inputLabel(op.inputs[segment.inputSlot]!, spec, artifacts, revisions)}）`).join(" → ")}{op.parameters.assembly === "timed_narrated_concat" ? ` · 旁白：${inputLabel(op.inputs[op.parameters.narrationInputSlot]!, spec, artifacts, revisions)}` : null}</>
        : op.parameters.assembly === "narrated_concat"
        ? <>画面顺序：{op.parameters.videoInputSlots.map(slot => inputLabel(op.inputs[slot]!, spec, artifacts, revisions) + slotFitLabel(op.parameters, slot)).join(" → ")} · 旁白：{inputLabel(op.inputs[op.parameters.narrationInputSlot]!, spec, artifacts, revisions)}</>
        : <>拼接顺序：{op.inputs.map((ref, slot) => inputLabel(ref, spec, artifacts, revisions) + slotFitLabel(op.parameters, slot)).join(" → ")}</>}
    </p>)}
    <details className="agent-scope-details" onToggle={event => setScopeOpen(event.currentTarget.open)}><summary>查看制作范围 · {spec.operations.length} 项操作</summary>
      <ul className="agent-proposal-operations">{spec.operations.map(op => {
        const opTitle = operationDisplayName(op, spec.operations, reuses);
        const kindPool = op.kind !== "render" ? poolModels.filter(m => m.kind === op.kind && m.availability === "configured") : [];
        const modelInfo = op.model ? modelLabelOf(op.model, spec, poolModels) : null;
        const isColabOp = op.model?.providerId === "colab" || modelInfo?.externalUnit === "colab_cu";
        return <li key={op.operationId}>
          <strong>{opTitle}</strong><span className="agent-operation-line">{operationSummary(op)}</span>
          <span className="agent-operation-line">
            {isColabOp
              ? "每次 ¥0.00 + Colab CU（预计约 0.22–1.43 CU，按实际运行时长） · 最多 1 次"
              : `每次 ${money(op.quotePerAttempt.amountMinor ?? 0)}（${op.priceKind === "estimate" ? "估价" : "封顶"}） · 最多 ${op.maxCreateAttempts} 次`}
          </span>
          <ol className="agent-operation-inputs" aria-label={`${op.operationId} 的输入`}>{op.inputs.map((ref, index) => <li key={index}>
            {ref.kind === "text" ? <span className="agent-production-text"><small>本次使用的文字</small><span>{ref.text}</span></span> : ref.kind === "artifact_revision" && onOpen ? <button type="button" onClick={() => onOpen(ref.artifactId, ref.revisionId)}>{inputLabel(ref, spec, artifacts, revisions)}</button> : inputLabel(ref, spec, artifacts, revisions)}
          </li>)}</ol>
          {op.model ? <dl className="agent-model-binding"><dt>模型</dt><dd>{modelInfo ? `${modelInfo.full}（${op.model.modelId}）` : `${op.model.providerId} / ${op.model.modelId}`}</dd></dl> : null}
          {scopeOpen && canEditModels && op.kind !== "render" && onRebindOperation && kindPool.length > 0 ? <div className="agent-op-model-picker">
            <ModelPoolSelect
              id={`op-model-${op.operationId}`}
              label={`更换 ${opTitle} 的模型`}
              currentBinding={op.model}
              isPendingSelection={sourceMap.get(op.operationId) === "pending_selection"}
              defaultBinding={defaultsMap?.[op.kind]}
              poolOptions={kindPool}
              targetOps={[op]}
              disabled={rebinding}
              spec={spec}
              allPoolModels={poolModels}
              onSelect={chosen => onRebindOperation(op, chosen.binding, chosen.defaultVoiceId)}
            />
          </div> : null}
        </li>;
      })}</ul>
    </details>
  </>;
}

function ProposalPrice({ proposal }: { proposal: Proposal }) {
  const totalMinor = proposal.spec.operations.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
  const estimated = proposal.spec.operations.some(op => op.priceKind === "estimate");
  const simulated = proposal.spec.operations.some(op => op.model?.providerId === "fixture-text");
  const speech = proposal.spec.operations.filter(op => op.kind === "speech");
  const speechMinor = speech.reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
  const colabCount = proposal.spec.operations.filter(op => op.model?.providerId === "colab").length;
  const zeroLocalRender = proposal.spec.operations.some(op => op.kind === "render" && op.quotePerAttempt.amountMinor === 0);
  return <>
    <p className="agent-proposal-price-headline">{estimated ? "估算" : "报价"} {money(totalMinor)} · 本次授权 {money(proposal.spec.maxSpend.amountMinor)}。{estimated ? "估算不代表实际账单或供应商账单封顶。" : "报价不代表实际账单。"}</p>
    {colabCount > 0 ? <p className="agent-model-note agent-colab-cu-note">算力分开核算：含 {colabCount} 镜 Google Colab 计算单元（预计约 0.22–1.43 CU/镜，实际用量按运行时长记录，不计入厂商人民币账单）。</p> : null}
    {zeroLocalRender ? <p className="agent-model-note">{speech.length ? `本次新配音 ${money(speechMinor)}；` : ""}本地合成 ¥0.00 仅指该操作无媒体供应商费用，其他制作操作与运行成本需分别核对。</p> : null}
    {simulated ? <p className="agent-model-note">模拟媒体，仅验证流程，不发生真实扣费。</p> : null}
    <details className="agent-scope-details"><summary>费用说明</summary><p>{proposal.priceDisclosure}</p></details>
  </>;
}

export function ProposalCard({
  proposal,
  budgetRemaining,
  onAccept,
  onReply,
  busy = false,
  artifacts,
  revisions,
  works = [],
  onOpen,
  onOpenRun,
  poolModels = [],
  onRebind,
  onOpenModelsSettings,
}: ScopeProps & {
  proposal: Proposal;
  onAccept?: ((proposal: Proposal) => void) | undefined;
  onReply?: (proposal: Proposal) => void;
  budgetRemaining?: number | null | undefined;
  busy?: boolean;
  onOpenRun?: ((runId: string) => void) | undefined;
  poolModels?: readonly PoolModelEntry[] | undefined;
  onRebind?: ((proposal: Proposal, changes: RebindProposal["changes"]) => Promise<Proposal>) | undefined;
  onOpenModelsSettings?: (() => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  const [editingModels, setEditingModels] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  const [rebindError, setRebindError] = useState("");
  const [failedChanges, setFailedChanges] = useState<RebindProposal["changes"] | null>(null);

  useEffect(() => {
    const delay = Date.parse(proposal.expiresAt) - Date.now();
    if (delay <= 0) { setNow(Date.now()); return; }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(delay + 50, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [proposal.expiresAt]);

  const expired = Date.parse(proposal.expiresAt) <= now && proposal.state !== "accepted";
  const ready = proposal.state === "ready" && !expired;
  const mediaOps = proposal.spec.operations.filter((op): op is MediaOperationSpec => op.kind !== "render");
  const involvedKinds = MEDIA_KIND_ORDER.filter(kind => mediaOps.some(op => op.kind === kind));
  const modernSpec = "type" in proposal.spec ? proposal.spec : null;
  const hasPoolSnapshot = Boolean(modernSpec?.defaultsAtPrepare);
  const defaultsAtPrepare = modernSpec?.defaultsAtPrepare;
  const selectionSources = new Map((modernSpec?.selectionSources ?? []).map(item => [item.operationId, item.source]));

  // 检查是否因绑定停用而变为 stale（仍未受理且未过期，允许在卡内换绑恢复就绪）。
  const hasDisabledBoundModel = involvedKinds.some(kind => {
    const kindPool = poolModels.filter(m => m.kind === kind && m.availability === "configured");
    if (kindPool.length === 0) return false;
    return mediaOps.filter(op => op.kind === kind).some(op => !kindPool.some(m => sameBinding(m.binding, op.model)));
  });
  const canEditModels = Boolean(
    onRebind
    && modernSpec
    && involvedKinds.length > 0
    && proposal.acceptedRunId === null
    && proposal.state !== "accepted"
    && !expired
    && (proposal.state === "ready" || hasDisabledBoundModel),
  );

  const needsInitialSelection = proposal.acceptanceBlocker?.code === "MODEL_SELECTION_REQUIRED";
  const drawerOpen = editingModels || (canEditModels && (needsInitialSelection || hasDisabledBoundModel));

  const isOpMatchingDefault = (op: MediaOperationSpec): boolean => {
    if (!defaultsAtPrepare) return true;
    const defBinding = defaultsAtPrepare[op.kind] ?? null;
    if (!defBinding || !sameBinding(op.model, defBinding)) return false;
    if (sourceMapHasPending(op.operationId)) return false;
    if (op.kind === "speech") {
      const defLabel = modelLabelOf(defBinding, proposal.spec, poolModels);
      if (defLabel.defaultVoiceId && op.parameters.voiceId !== defLabel.defaultVoiceId) return false;
    }
    return true;
  };
  function sourceMapHasPending(operationId: string): boolean {
    return selectionSources.get(operationId) === "pending_selection";
  }

  const allMatchingDefault = hasPoolSnapshot && mediaOps.length > 0 && mediaOps.every(isOpMatchingDefault);
  const hasOverriddenOps = hasPoolSnapshot && mediaOps.some(op => !isOpMatchingDefault(op) && !sourceMapHasPending(op.operationId));
  const canRestoreDefaults = Boolean(
    canEditModels
    && hasOverriddenOps
    && defaultsAtPrepare
    && mediaOps.every(op => !isOpMatchingDefault(op) ? Boolean(defaultsAtPrepare[op.kind]) : true),
  );

  const submitRebind = async (changes: RebindProposal["changes"]) => {
    if (!onRebind || rebinding || !changes.length) return;
    setRebinding(true);
    setRebindError("");
    setFailedChanges(changes);
    try {
      await onRebind(proposal, changes);
      setFailedChanges(null);
    } catch (error) {
      setRebindError(error instanceof Error ? error.message : "报价更新失败，原选择已保留，请重试。");
    } finally {
      setRebinding(false);
    }
  };

  const restoreProposalDefaults = () => {
    if (!defaultsAtPrepare) return;
    const changes = mediaOps
      .filter(op => !isOpMatchingDefault(op) && defaultsAtPrepare[op.kind])
      .map(op => {
        const defBinding = defaultsAtPrepare[op.kind]!;
        const defInfo = modelLabelOf(defBinding, proposal.spec, poolModels);
        return {
          operationId: op.operationId,
          model: defBinding,
          ...(op.kind === "speech" && defInfo.defaultVoiceId ? { voiceId: defInfo.defaultVoiceId } : {}),
        };
      });
    if (changes.length) {
      void submitRebind(changes as RebindProposal["changes"]);
    }
  };

  // 受理门以服务端推导的 blocker 为准；换绑请求在途期间禁用确认防止提交旧 digest。
  const startable = ready && proposal.acceptanceBlocker === null && !rebinding;
  const confirmButtonLabel = proposal.state === "accepted"
    ? "已受理"
    : rebinding
    ? "正在更新报价…"
    : busy
    ? "正在确认…"
    : needsInitialSelection
    ? "请先选择模型"
    : hasPoolSnapshot && mediaOps.length > 0
    ? allMatchingDefault
      ? "使用默认模型并开始制作"
      : "按本次选择开始制作"
    : "确认制作";

  const showPrimaryButton = startable || proposal.state === "accepted" || rebinding || (ready && needsInitialSelection);

  return <div className="frame-production-proposal" data-state={proposal.state}>
    <header><strong>{proposal.spec.title}</strong><span>{expired && proposal.state !== "accepted" ? "已过期" : PROPOSAL_STATE_LABEL[proposal.state]}</span></header>
    <ProposalScope
      spec={proposal.spec}
      audioSummary={proposal.audioSummary}
      artifacts={artifacts}
      revisions={revisions}
      works={works}
      onOpen={onOpen}
      canEditModels={canEditModels}
      rebinding={rebinding}
      poolModels={poolModels}
      onRebindOperation={(op, model, defaultVoiceId) => {
        const voiceId = op.kind === "speech"
          ? (sameBinding(op.model, model) ? op.parameters.voiceId : defaultVoiceId)
          : undefined;
        void submitRebind([{ operationId: op.operationId, model, ...(voiceId ? { voiceId } : {}) }]);
      }}
    />

    {involvedKinds.length > 0 && (hasPoolSnapshot || poolModels.some(m => m.kind !== "text")) ? (
      <section className="agent-proposal-models" aria-label="本次生成模型与费用摘要">
        <div className="agent-proposal-models-header">
          <strong>本次生成模型</strong>
          <div className="agent-proposal-models-tools">
            {canRestoreDefaults ? (
              <button type="button" className="agent-text-link" disabled={rebinding || busy} onClick={restoreProposalDefaults}>
                恢复本方案默认
              </button>
            ) : null}
            {canEditModels ? (
              <button
                type="button"
                className="agent-proposal-adjust-btn"
                aria-expanded={drawerOpen}
                disabled={rebinding || busy}
                onClick={() => { setEditingModels(open => !open); setRebindError(""); }}
              >
                {drawerOpen && !needsInitialSelection && !hasDisabledBoundModel ? "收起调整" : "调整模型"}
              </button>
            ) : null}
          </div>
        </div>

        <ul className="agent-proposal-model-rows">
          {involvedKinds.map(kind => {
            const ops = mediaOps.filter(op => op.kind === kind);
            const distinctRevs = [...new Set(ops.map(op => op.model.configurationRevisionId))];
            const primaryOp = ops[0]!;
            const primaryInfo = modelLabelOf(primaryOp.model, proposal.spec, poolModels);
            const defBinding = defaultsAtPrepare?.[kind];
            const defInfo = defBinding !== undefined ? (defBinding ? modelLabelOf(defBinding, proposal.spec, poolModels) : null) : undefined;
            const kindPending = ops.some(op => sourceMapHasPending(op.operationId));
            const kindAllDefault = hasPoolSnapshot && ops.every(isOpMatchingDefault);
            const cnyMinor = ops
              .filter(op => op.model.providerId !== "colab")
              .reduce((sum, op) => sum + (op.quotePerAttempt.amountMinor ?? 0) * op.maxCreateAttempts, 0);
            const colabOpsCount = ops.filter(op => op.model.providerId === "colab").length;
            const costText = colabOpsCount === ops.length
              ? `¥0.00 + Colab CU（${ops.length > 1 ? `${ops.length} 镜，` : ""}预计约 0.22–1.43 CU/镜）`
              : colabOpsCount > 0
              ? `${money(cnyMinor)} 估价 + ${colabOpsCount} 镜 Colab CU`
              : primaryOp.model.providerId === "edge-tts"
              ? "¥0.00 免费配音"
              : `${money(cnyMinor)}${ops.some(op => op.priceKind === "estimate") ? " 估价" : ""}`;

            // 统计同类多镜中的逐镜例外，收起态也常显每个例外的具体连接与型号。
            const baseRev = choosePrimaryRevision(ops, selectionSources, defBinding);
            const baseOp = ops.find(op => op.model.configurationRevisionId === baseRev)!;
            const baseInfo = modelLabelOf(baseOp.model, proposal.spec, poolModels);
            const exceptionOps = distinctRevs.length > 1
              ? ops.filter(op => op.model.configurationRevisionId !== baseRev)
              : [];

            return <li key={kind} className="agent-proposal-model-row">
              <div className="agent-proposal-model-main">
                <span className="agent-proposal-kind-pill">
                  {KINDS[kind]}{ops.length > 1 ? ` · ${ops.length} ${kind === "video" ? "镜" : "项"}` : ""}
                </span>
                <span className="agent-proposal-model-identity">
                  {kindPending ? (
                    <span className="agent-model-pending-text">待选择模型（候选：{primaryInfo.full}）</span>
                  ) : distinctRevs.length === 1 ? (
                    <>
                      <strong>{primaryInfo.full}</strong>
                      {kind === "speech" && primaryOp.kind === "speech" ? (
                        <span className="agent-proposal-voice-tag">
                          音色：{voiceLabelOf(primaryOp.parameters.voiceId, primaryOp.model, poolModels)}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <strong>主选：{baseInfo.full}</strong>
                      <span className="agent-proposal-shot-exceptions">
                        单镜例外：{exceptionOps.map(ex => {
                          const idx = ops.indexOf(ex) + 1;
                          return `镜头 ${idx} 用 ${modelLabelOf(ex.model, proposal.spec, poolModels).full}`;
                        }).join("；")}
                      </span>
                    </>
                  )}
                </span>
                {hasPoolSnapshot ? (
                  <span
                    className="agent-proposal-source-badge"
                    data-source={kindPending ? "pending" : kindAllDefault ? "default" : "selected"}
                  >
                    {kindPending ? "待选" : kindAllDefault ? "默认" : "本次选用"}
                  </span>
                ) : null}
              </div>
              <div className="agent-proposal-model-meta">
                <span className="agent-proposal-model-cost">{costText}</span>
                {hasPoolSnapshot && !kindAllDefault && !kindPending ? (
                  <small className="agent-proposal-original-default">
                    方案原默认：{defInfo ? defInfo.full : "未设默认"}
                  </small>
                ) : null}
              </div>
            </li>;
          })}
        </ul>

        {drawerOpen && canEditModels ? (
          <div className="agent-proposal-model-editor" role="group" aria-label="调整本次模型">
            {involvedKinds.map(kind => {
              const ops = mediaOps.filter(op => op.kind === kind);
              const kindPool = poolModels.filter(m => m.kind === kind && m.availability === "configured");
              const defBinding = defaultsAtPrepare?.[kind];
              // 批量切换保留已单独钉住的例外镜头（除非全部相同），平局时优先保留单改镜头不动。
              const counts = new Map<string, number>();
              for (const op of ops) counts.set(op.model.configurationRevisionId, (counts.get(op.model.configurationRevisionId) ?? 0) + 1);
              const majorityRev = choosePrimaryRevision(ops, selectionSources, defBinding);
              const batchTargetOps = ops.length > 1 && counts.size > 1
                ? ops.filter(op => op.model.configurationRevisionId === majorityRev)
                : ops;
              const representativeOp = batchTargetOps[0]!;
              const speechEntry = kind === "speech"
                ? kindPool.find(m => sameBinding(m.binding, representativeOp.model))
                : undefined;
              const unifyChosen = kindPool.find(m => sameBinding(m.binding, representativeOp.model));
              const unifyReason = unifyChosen ? batchCompatibilityReason(unifyChosen, ops) : "当前型号不可用";
              const hasIncompatibleOption = kindPool.some(entry => batchCompatibilityReason(entry, batchTargetOps) !== null);

              if (kindPool.length === 0) {
                return <div key={kind} className="agent-proposal-empty-pool">
                  <span>当前没有已启用的{KINDS[kind]}模型。</span>
                  {onOpenModelsSettings ? <button type="button" className="agent-text-link" onClick={onOpenModelsSettings}>前往模型配置</button> : null}
                </div>;
              }

              return <div key={kind} className="agent-proposal-editor-group">
                <ModelPoolSelect
                  id={`proposal-${proposal.id}-kind-${kind}`}
                  label={ops.length > 1 ? `整批${KINDS[kind]}模型` : `选择本次${KINDS[kind]}模型`}
                  currentBinding={representativeOp.model}
                  isPendingSelection={ops.some(op => sourceMapHasPending(op.operationId))}
                  defaultBinding={defBinding}
                  poolOptions={kindPool}
                  targetOps={batchTargetOps}
                  disabled={rebinding || busy}
                  spec={proposal.spec}
                  allPoolModels={poolModels}
                  onSelect={chosen => {
                    const changes = batchTargetOps.map(op => ({
                      operationId: op.operationId,
                      model: chosen.binding,
                      ...(op.kind === "speech" && chosen.defaultVoiceId ? { voiceId: chosen.defaultVoiceId } : {}),
                    }));
                    void submitRebind(changes as RebindProposal["changes"]);
                  }}
                />
                {ops.length > 1 && counts.size > 1 ? (
                  <div className="agent-proposal-batch-note">
                    <span>已保留 {ops.length - batchTargetOps.length} 个单独调整的镜头；</span>
                    <button
                      type="button"
                      className="agent-text-link"
                      disabled={rebinding || busy || unifyReason !== null}
                      title={unifyReason ?? undefined}
                      onClick={() => {
                        if (!unifyChosen || unifyReason !== null) return;
                        void submitRebind(
                          ops.map(op => ({
                            operationId: op.operationId,
                            model: unifyChosen.binding,
                            ...(op.kind === "speech" && unifyChosen.defaultVoiceId ? { voiceId: unifyChosen.defaultVoiceId } : {}),
                          })) as RebindProposal["changes"],
                        );
                      }}
                    >
                      全部 {ops.length} 镜统一为此型号
                    </button>
                    {unifyReason ? <small className="agent-proposal-editor-hint">（不可统一：{unifyReason}）</small> : null}
                  </div>
                ) : ops.length > 1 ? (
                  <small className="agent-proposal-editor-hint">只需改单镜？展开上方「查看制作范围」可在指定镜头旁单独更换。</small>
                ) : null}
                {kind === "speech" && representativeOp.kind === "speech" && speechEntry?.voices && speechEntry.voices.length > 0 ? (
                  <label className="agent-pool-select-field" htmlFor={`proposal-${proposal.id}-voice`}>
                    <span>配音音色</span>
                    <select
                      id={`proposal-${proposal.id}-voice`}
                      aria-label="选择本次配音音色"
                      value={representativeOp.parameters.voiceId}
                      disabled={rebinding || busy}
                      onChange={event => {
                        const nextVoice = event.target.value;
                        void submitRebind(
                          batchTargetOps.map(op => ({ operationId: op.operationId, model: op.model, voiceId: nextVoice })) as RebindProposal["changes"],
                        );
                      }}
                    >
                      {speechEntry.voices.map(voice => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}{speechEntry.defaultVoiceId === voice.id ? " [默认音色]" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {hasIncompatibleOption ? (
                  <small className="agent-proposal-editor-hint">
                    不可选型号需单张首帧图或不同时长/画幅，可点下方「回复这份提案」回对话调整或先完成分镜审阅。
                  </small>
                ) : null}
              </div>;
            })}
          </div>
        ) : null}

        {rebindError ? (
          <div className="agent-proposal-rebind-error" role="alert">
            <span>{rebindError}</span>
            {failedChanges ? (
              <button type="button" className="agent-text-link" disabled={rebinding} onClick={() => void submitRebind(failedChanges)}>
                重试更新报价
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    ) : null}

    <ProposalPrice proposal={proposal} />
    {ready && proposal.spec.maxSpend.amountMinor > 0 && budgetRemaining !== undefined
      ? <p className="agent-model-note">{budgetRemaining === null ? "当前未设额度上限" : "当前可用额度 " + money(budgetRemaining)}</p> : null}
    {ready && startable ? <p className="agent-model-note">确认后锁定本次输入，意见留给下一版。</p> : null}
    {ready && !startable && proposal.acceptanceBlocker ? <p className="agent-model-note" role="status">{proposal.acceptanceBlocker.message}</p> : null}
    {hasDisabledBoundModel && !ready && canEditModels ? (
      <p className="agent-model-note" role="status">原选模型已停用，请在上方改选池内其他可用模型以更新报价。</p>
    ) : null}
    <div className="agent-production-actions">
      {showPrimaryButton ? (
        <button
          type="button"
          disabled={!ready || !startable || !onAccept || busy || rebinding}
          onClick={() => onAccept?.(proposal)}
          title={!onAccept ? "制作能力尚未接入" : undefined}
        >
          {confirmButtonLabel}
        </button>
      ) : null}
      {proposal.acceptedRunId && onOpenRun ? <button type="button" onClick={() => onOpenRun(proposal.acceptedRunId!)}>查看制作记录</button> : null}
      {(ready || (canEditModels && !expired)) && onReply ? <button type="button" onClick={() => onReply(proposal)}>回复这份提案</button> : null}
    </div>
  </div>;
}

export function RunCard({ run, onCancel, onOpen, simulated, proposals = [], artifacts, revisions, works = [], onRetry }: ScopeProps & {
  run: Run; onCancel: (run: Run) => void; onOpen: (id: string, revisionId: string) => void; simulated: boolean; proposals?: Proposal[]; onRetry?: () => void;
}) {
  // 本地请求直接受理的制作没有提案事实；提案来源的 run 才有原提案可回看。
  const originProposalId = run.origin.kind === "proposal" ? run.origin.proposalId : null;
  const proposal = originProposalId ? proposals.find(item => item.id === originProposalId) : null;
  const finished = run.operations.filter(op => op.state === "succeeded").length;
  const percent = run.state === "succeeded" ? 100
    : finished < run.operations.length ? Math.round((finished / run.operations.length) * 100) : null;
  return <div className="agent-run" data-state={run.state}>
    <header><strong>{run.title}</strong><span>{RUN_STATE_LABEL[run.state]}</span></header>
    <p>{run.operations.length} 个制作步骤 · 已完成 {finished}{percent !== null ? `（${percent}%）` : ""}</p>
    <ol className="agent-run-operations">{run.operations.map(op => <li key={op.operationId} data-state={op.state}>
      <span>{operationLabel(op, run.operations)}</span><small>{OP_STATE_LABEL[op.state]}</small>
    </li>)}</ol>
    {simulated ? <p className="agent-model-note">模拟执行 · 无真实媒体扣费</p> : null}
    {run.issue ? <p role="status">{run.issue.message}</p> : null}
    {run.audioSummary ? <AudioSummaryView summary={run.audioSummary} title="本次制作的声音" /> : null}
    <p>{run.finance == null ? "本次制作无供应商费用记账。"
      : run.finance.state === "settled" ? `费用已核对 · ${money(run.finance.settledMinor)}`
      : run.finance.state === "pending_reconciliation"
      ? `供应商账单待核对（${run.finance.settledMinor > 0 ? `已核对 ${money(run.finance.settledMinor)}，` : ""}待核对部分估算 ${money(run.finance.pendingUnknownMinor)}）`
      : `已授权制作 · 本次预留 ${money(run.finance.reservedMinor)}`}</p>
    {run.origin.kind === "proposal" ? (proposal ? <details className="agent-run-scope"><summary>回看原提案：{proposal.spec.title}</summary>
        <ProposalPrice proposal={proposal} /><ProposalScope spec={proposal.spec} audioSummary={proposal.audioSummary} artifacts={artifacts} revisions={revisions} works={works} onOpen={onOpen} />
      </details> : <p>原提案暂不可读。<button type="button" onClick={onRetry}>重试读取</button></p>) : null}
    <div className="agent-production-actions">
      {run.outputRevisions.map((ref, index) => <button type="button" key={ref.revisionId} onClick={() => onOpen(ref.artifactId, ref.revisionId)}>查看{run.outputRevisions.length > 1 ? `产出 ${index + 1}` : "产出"}</button>)}
      {!runEnded(run.state) ? <button type="button" disabled={run.state === "cancel_requested"} onClick={() => onCancel(run)}>停止制作</button> : null}
    </div>
  </div>;
}

// T3 来源署名：按实际 sources 数组展示作者/来源/许可；无来源不造署名，旧记录缺省视为空。
// 托盘收拢为单行摘要（舞台纵向预算按此计提）：完整署名与适用范围折叠在详情内，展开时由舞台滚动承接。
function MediaSources({ sources }: { sources: MediaContent["sources"] }) {
  if (!sources?.length) return null;
  const needsAttribution = sources.some(source => source.attributionText || source.usageScope);
  return <details className="agent-media-sources" aria-label="素材来源">
    <summary>素材来源 · {sources.length} 项{needsAttribution ? " · 发布需保留署名" : ""}</summary>
    {sources.map(source => <div key={`${source.provider}:${source.assetId}`}>
      {source.title ? <strong>{source.title}</strong> : null}
      <MediaSourceDetails source={source} />
    </div>)}
  </details>;
}

export function MediaPreview({ content, simulated, onTimeUpdate, initialTime, revision, finalized, mainProject, projects }: {
  content: MediaContent; revision?: ArtifactRevision; finalized?: boolean; mainProject?: RevisionRef | null; projects?: RevisionRef[]; simulated: boolean; onTimeUpdate?: ((seconds: number) => void) | undefined; initialTime?: number | undefined }) {
  const url = blobUrl(content.blobId);
  const [dimensions, setDimensions] = useState<{ blobId: string; width: number; height: number } | null>(null);
  const size = dimensions?.blobId === content.blobId ? dimensions : null;
  return <div className="agent-preview-media">
    {content.mimeType.startsWith("video/") ? <video key={url} controls preload="metadata" src={url} poster={blobUrl(content.blobId, "poster")} aria-label={finalized ? "定稿视频" : "视频预览"} onTimeUpdate={event => onTimeUpdate?.(event.currentTarget.currentTime)}
      style={size ? { "--frame-video-ratio": size.width / size.height, aspectRatio: `${size.width} / ${size.height}` } as CSSProperties : undefined}
      onLoadedMetadata={event => {
        const video = event.currentTarget;
        if (video.videoWidth && video.videoHeight) setDimensions({ blobId: content.blobId, width: video.videoWidth, height: video.videoHeight });
        if (initialTime) video.currentTime = Math.min(initialTime, video.duration);
      }}>{revision && content.subtitles?.mode === "soft" ? <track default kind="captions" label="作品字幕" src={subtitleDownloadUrl(revision, "vtt")} /> : null}</video>
      : content.mimeType.startsWith("image/") ? <img src={url} alt={content.upload?.fileName ?? "图片产出"} onLoad={event => {
        const image = event.currentTarget;
        setDimensions({ blobId: content.blobId, width: image.naturalWidth, height: image.naturalHeight });
      }} /> : <audio key={url} controls preload="metadata" src={url} aria-label={content.upload || !content.sources?.length ? "音频预览" : "音乐预览"}
        onTimeUpdate={event => onTimeUpdate?.(event.currentTarget.currentTime)} onLoadedMetadata={event => { if (initialTime) event.currentTarget.currentTime = Math.min(initialTime, event.currentTarget.duration); }} />}
    {content.mimeType.startsWith("image/") && dimensions?.blobId === content.blobId && dimensions.width > 0 && dimensions.height > 0
      ? <span className="agent-stage-muted">实际尺寸 {dimensions.width}×{dimensions.height}</span> : null}
    {/* B13-POLISH-02 放映信息托条：连接说明/导出/来源收进同一条带，舞台内呈现为暖灰托盘（见 review-workspace.css）。 */}
    <div className="agent-stage-plinth">
      {simulated && !content.upload ? <small className="agent-stage-muted">模拟媒体连接</small> : null}
      {revision ? <RevisionExports key={revision.revisionId} revision={revision} mainProject={mainProject} projects={projects} finalized={finalized} /> : <a href={url} download>下载文件</a>}
      <MediaSources sources={content.sources} />
    </div>
  </div>;
}

const TEXT_PREVIEW_BYTES = 256 * 1024;

async function readTextPreview(url: string, signal: AbortSignal): Promise<{ value: string; truncated: boolean }> {
  // 多取一字节才能区分恰好达到上限和仍有后文。即使服务器忽略 Range，也及时停止读取。
  const response = await fetch(url, { headers: { Range: `bytes=0-${TEXT_PREVIEW_BYTES}` }, signal });
  if (response.status === 416 && response.headers.get("content-range") === "bytes */0") return { value: "", truncated: false };
  if (!response.ok || !response.body) throw new Error(`工程文件读取失败（${response.status}）`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "", remaining = TEXT_PREVIEW_BYTES;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { value: value + decoder.decode(), truncated: false };
      value += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
      remaining -= chunk.value.byteLength;
      if (remaining < 0) {
        await reader.cancel();
        return { value, truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function FilePreview({ content, showPath = true }: { content: FileContent; showPath?: boolean }) {
  const url = blobUrl(content.blobId);
  const textual = content.mimeType.startsWith("text/") || ["application/json", "application/javascript", "application/xml", "image/svg+xml"].includes(content.mimeType);
  const [read, setRead] = useState<{ url: string; value: string; truncated: boolean } | { url: string; error: true } | null>(null);
  useEffect(() => {
    if (!textual || content.sizeBytes === 0) return;
    const controller = new AbortController();
    readTextPreview(url, controller.signal).then(result => {
      if (!controller.signal.aborted) setRead({ url, ...result });
    }, () => {
      if (!controller.signal.aborted) setRead({ url, error: true });
    });
    return () => controller.abort();
  }, [textual, url, content.sizeBytes]);
  const result = content.sizeBytes === 0 ? { value: "", truncated: false } : read?.url === url ? read : null;
  return <div className="agent-preview-file">
    {showPath ? <p className="agent-file-facts">{content.path}<small>{content.mimeType}</small></p> : null}
    <a href={url + "?download=1"} download={content.path.split("/").at(-1)}>下载文件</a>
    {textual ? result && "error" in result ? <p className="agent-stage-muted" role="status">文本读取失败，可下载原文件。</p>
      : result ? <>{result.value.length || result.truncated ? <pre className="agent-file-text">{result.value}</pre> : <p className="agent-stage-muted">空文件</p>}
        {result.truncated ? <p className="agent-stage-muted">内容较长，仅显示前 256 KiB。</p> : null}</> : <p className="agent-stage-muted">正在读取…</p>
      : <p className="agent-stage-muted">二进制文件不在页面内解释，请下载原字节使用。</p>}
  </div>;
}

export function ProjectFileDisclosure({ file, label, purpose }: {
  file: Pick<CreativeProjectContent["files"][number], "relativePath" | "blobId" | "mimeType" | "sizeBytes">;
  label?: string; purpose?: string;
}) {
  const [open, setOpen] = useState(false);
  // 早期封存的 TSX 等源码统一登记为 octet-stream，展示时按该版清单的文件名读取为纯文本。
  const mimeType = file.mimeType === undefined || file.mimeType === "application/octet-stream" ? projectFileMime(file.relativePath) : file.mimeType;
  return <details className="agent-project-file" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label ?? file.relativePath}{purpose ? <small>{purpose === "source" ? "源文件" : purpose}</small> : null}</summary>
    {open ? <FilePreview key={file.blobId} showPath={false} content={{ format: "file", path: file.relativePath, blobId: file.blobId, ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
      mimeType }} /> : null}
  </details>;
}

export function ProjectPreview({ content, revision }: { content: CreativeProjectContent; revision?: ArtifactRevision }) {
  return <div className="agent-preview-project">
    <p>{content.files.length} 个文件{content.timelineFiles.length ? ` · ${content.timelineFiles.length} 个时间线文件` : ""}{content.dependencyLocks.length ? ` · ${content.dependencyLocks.length} 个锁定依赖` : ""}</p>
    <ul>{content.files.map(file => <li key={file.relativePath}><ProjectFileDisclosure file={file} purpose={file.purpose} /></li>)}</ul>
    <p className="agent-stage-muted">入口 {content.entrypoint.argv.join(" ")} · 运行镜像 {content.runtimeImage}</p>
    {revision ? <RevisionExports revision={revision} /> : null}
  </div>;
}

// 修订正文按 format 判别渲染；调用方只提供准确修订，不预读内容。
export function RevisionBody({ revision, simulated, onTimeUpdate, initialTime, subtitleEditor }: { revision: ArtifactRevision; simulated: boolean;
  onTimeUpdate?: ((seconds: number) => void) | undefined; initialTime?: number | undefined; subtitleEditor?: { buffers: ReviewBuffers; onSaved: (ref: RevisionRef) => void } | undefined;
}) {
  const { content, archivedAt } = revision;
  if (archivedAt) return <p className="agent-stage-muted" role="status">这份历史草稿的媒体已超过保留期，现已归档。定稿和已认可版本仍可查看。</p>;
  if (content.format === "subtitles") return <Suspense fallback={<p>正在读取字幕…</p>}><SubtitleTrackPanel key={revision.revisionId} track={content} revision={revision} editor={subtitleEditor} /></Suspense>;
  if (content.format === "markdown") return <MarkdownBody content={content} />;
  if (content.format === "media") return <MediaPreview revision={revision} content={content} simulated={simulated} onTimeUpdate={onTimeUpdate} initialTime={initialTime} />;
  if (content.format === "file") return <FilePreview content={content} />;
  return <ProjectPreview content={content} revision={revision} />;
}
