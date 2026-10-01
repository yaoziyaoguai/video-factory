/** §2.4/§2.5 纯本地排轨动作的 TS 合同：DTO 解析、幂等记录与回执身份。 */

export const RELAYOUT_OPERATION_VERSION = "video-factory/narration-relayout-operation-v1";
export const RELAYOUT_COMPLETION_VERSION = "video-factory/narration-relayout-completion-v1";
export const NARRATION_FIT_CONFLICT_V2_VERSION = "video-factory/narration-fit-conflict-v2";

export interface NarrationRelayoutCompletionArtifact {
  kind: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface NarrationRelayoutCompletion {
  version: typeof RELAYOUT_COMPLETION_VERSION;
  requestDigest: string;
  commandId: string;
  layoutOperationId: string;
  runId: string;
  nodeId: "voice";
  attempt: number;
  reservedInputVersionId: string;
  reservedOutputVersionId: string;
  source: Record<string, unknown>;
  output: {
    narrationPlanRelativePath: string;
    pcmRelativePath: string;
    trackRelativePath: string;
    voiceoverPlanRelativePath: string;
    narrationMode: "continuous_groups";
    subtitleStatus: string;
    layoutKey: string;
    voiceOperationId: string;
    layoutOperationId: string;
    externalSendCount: 0;
  };
  artifacts: NarrationRelayoutCompletionArtifact[];
}

export interface NarrationFitConflictV2 {
  version: typeof NARRATION_FIT_CONFLICT_V2_VERSION;
  code: "NARRATION_GROUP_DOES_NOT_FIT_V2";
  groupId: string;
  sourceRange: { baseGroupId: string; startCodePoint: number; endCodePoint: number };
  sourceScenePositions: number[];
  window: { startFrame: number; endFrame: number };
  placement: { anchor: "start" | "end"; offsetFrames: number };
  sourceSamples: number;
  requiredFrames: number;
  availableFrames: number;
  shortfallFrames: number;
  sourceOperationId: string;
  sourceContextId: string;
  manifestArtifactId: string;
  manifestSha256: string;
}

export type RelayoutNarrationSource = {
  kind: "voice_version";
  voiceVersionId: string;
  voicePlanArtifactId: string;
  voicePlanSha256: string;
  expectedNarrationPlanSha256: string;
  expectedLayoutKey: string;
  expectedAudioSha256: string;
  sourceVoiceOperationId: string;
} | {
  kind: "materialized_operation";
  voiceInputVersionId: string;
  sourceVoiceOperationId: string;
  sourceManifestArtifactId: string;
  sourceManifestSha256: string;
  sourceReceiptArtifactId: string;
};

export interface RelayoutNarrationDraft {
  action: "relayout_narration";
  intent: "apply";
  requestId: string;
  expectedRunRevision: number;
  interventionId: string;
  sourceContextId: string;
  note: string;
  source: RelayoutNarrationSource;
  layout: {
    narrationPlanVersion: "video-factory/narration-plan-v1" | "video-factory/narration-plan-v2";
    groups: Array<{ groupId: string;
      window: { startFrame: number; endFrame: number };
      placement: { anchor: "start" | "end"; offsetFrames: number } }>;
    userSilences: Array<{ startFrame: number; endFrame: number }>;
  };
}

export interface DiscardUnappliedRelayoutDraft {
  action: "relayout_narration";
  intent: "discard_unapplied";
  requestId: string;
  expectedRunRevision: number;
  interventionId: string;
  targetRequestId: string;
  note: string;
}

export type NarrationRelayoutRequest = RelayoutNarrationDraft | DiscardUnappliedRelayoutDraft;

const safeId = (value: unknown, label: string, maximum = 100): string => {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || !/^[A-Za-z0-9_.:@-]+$/.test(value)) {
    throw new Error(`${label}必须是宿主可核对的非空标识。`);
  }
  return value;
};

const sha256Hex = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label}必须是完整的 64 位十六进制摘要。`);
  }
  return value;
};

const safeInt = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}必须是非负安全整数。`);
  }
  return value;
};

const relativeArtifactPath = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value || value.length > 500 || value.startsWith("/")
    || value.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
    throw new Error(`${label}必须是本次 attempt 内的相对路径。`);
  }
  return value;
};

/** worker 返回父进程前写入的耐久完成事实；不接受父进程临时拼出的等价对象。 */
export function parseNarrationRelayoutCompletion(value: unknown): NarrationRelayoutCompletion {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("本地排轨完成收据必须是对象。");
  }
  const receipt = value as Record<string, unknown>;
  if (receipt.version !== RELAYOUT_COMPLETION_VERSION || receipt.nodeId !== "voice") {
    throw new Error("本地排轨完成收据版本或节点无效。");
  }
  const attempt = safeInt(receipt.attempt, "本地排轨 attempt");
  if (attempt < 1) throw new Error("本地排轨 attempt 必须从 1 开始。");
  const output = receipt.output as Record<string, unknown> | undefined;
  if (!output || output.narrationMode !== "continuous_groups" || output.externalSendCount !== 0) {
    throw new Error("本地排轨完成收据的安全输出不完整。");
  }
  const artifactsValue = receipt.artifacts;
  if (!Array.isArray(artifactsValue)) throw new Error("本地排轨完成收据缺少产物集合。");
  const artifacts = artifactsValue.map((candidate): NarrationRelayoutCompletionArtifact => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("本地排轨完成收据包含无效产物。");
    }
    const artifact = candidate as Record<string, unknown>;
    const contentType = artifact.contentType;
    if (typeof contentType !== "string" || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(contentType)) {
      throw new Error("完成产物内容类型无效。");
    }
    return {
      kind: safeId(artifact.kind, "完成产物类型", 100),
      relativePath: relativeArtifactPath(artifact.relativePath, "完成产物路径"),
      sha256: sha256Hex(artifact.sha256, "完成产物摘要"),
      sizeBytes: safeInt(artifact.sizeBytes, "完成产物大小"),
      contentType,
    };
  });
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (kinds.size !== artifacts.length
    || !["narration_plan", "voiceover_pcm", "voiceover", "voiceover_plan"]
      .every((kind) => kinds.has(kind))
    || (output.subtitleStatus === "verified"
      && !(kinds.has("narration_vtt") && kinds.has("narration_ass")))) {
    throw new Error("本地排轨完成收据缺少目标计划、PCM、音轨、时间线或适用字幕。");
  }
  if (!receipt.source || typeof receipt.source !== "object" || Array.isArray(receipt.source)) {
    throw new Error("本地排轨完成收据缺少来源身份。");
  }
  const commandId = safeId(receipt.commandId, "排轨命令", 200);
  const layoutOperationId = safeId(receipt.layoutOperationId, "布局操作", 200);
  const outputLayoutOperationId = safeId(output.layoutOperationId, "完成输出布局操作", 200);
  if (layoutOperationId !== outputLayoutOperationId) {
    throw new Error("本地排轨完成收据的布局操作身份不一致。");
  }
  return {
    version: RELAYOUT_COMPLETION_VERSION,
    requestDigest: sha256Hex(receipt.requestDigest, "排轨请求摘要"),
    commandId,
    layoutOperationId,
    runId: safeId(receipt.runId, "制作身份", 200),
    nodeId: "voice",
    attempt,
    reservedInputVersionId: safeId(receipt.reservedInputVersionId, "预留声音输入版本", 256),
    reservedOutputVersionId: safeId(receipt.reservedOutputVersionId, "预留声音输出版本", 256),
    source: receipt.source as Record<string, unknown>,
    output: {
      narrationPlanRelativePath: relativeArtifactPath(output.narrationPlanRelativePath, "目标旁白计划路径"),
      pcmRelativePath: relativeArtifactPath(output.pcmRelativePath, "未 mastering PCM 路径"),
      trackRelativePath: relativeArtifactPath(output.trackRelativePath, "音轨路径"),
      voiceoverPlanRelativePath: relativeArtifactPath(output.voiceoverPlanRelativePath, "声音时间线路径"),
      narrationMode: "continuous_groups",
      subtitleStatus: safeId(output.subtitleStatus, "字幕状态", 100),
      layoutKey: safeId(output.layoutKey, "布局键", 200),
      voiceOperationId: safeId(output.voiceOperationId, "原声音操作", 200),
      layoutOperationId: outputLayoutOperationId,
      externalSendCount: 0,
    },
    artifacts,
  };
}

/** 首次与再次 v2 fit 冲突的唯一消费合同。 */
export function parseNarrationFitConflictV2(value: unknown): NarrationFitConflictV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("v2 声音时序冲突必须是完整对象。");
  }
  const conflict = value as Record<string, unknown>;
  if (conflict.version !== NARRATION_FIT_CONFLICT_V2_VERSION
    || conflict.code !== "NARRATION_GROUP_DOES_NOT_FIT_V2") {
    throw new Error("v2 声音时序冲突版本或错误码无效。");
  }
  const sourceRange = conflict.sourceRange as Record<string, unknown> | undefined;
  const window = conflict.window as Record<string, unknown> | undefined;
  const placement = conflict.placement as Record<string, unknown> | undefined;
  if (!sourceRange || !window || !placement) {
    throw new Error("v2 声音时序冲突缺少来源、窗口或落点。");
  }
  const startCodePoint = safeInt(sourceRange.startCodePoint, "来源起点");
  const endCodePoint = safeInt(sourceRange.endCodePoint, "来源终点");
  const startFrame = safeInt(window.startFrame, "窗口起始帧");
  const endFrame = safeInt(window.endFrame, "窗口结束帧");
  const offsetFrames = safeInt(placement.offsetFrames, "落点偏移");
  const sourceSamples = safeInt(conflict.sourceSamples, "原声样本数");
  const requiredFrames = safeInt(conflict.requiredFrames, "需要帧数");
  const availableFrames = safeInt(conflict.availableFrames, "可用帧数");
  const shortfallFrames = safeInt(conflict.shortfallFrames, "缺口帧数");
  const sourceScenePositions = conflict.sourceScenePositions;
  if (endCodePoint <= startCodePoint || endFrame <= startFrame || sourceSamples <= 0
    || !Array.isArray(sourceScenePositions) || sourceScenePositions.length === 0
    || sourceScenePositions.some((position) => !Number.isSafeInteger(position) || Number(position) < 1)
    || (placement.anchor !== "start" && placement.anchor !== "end")
    || availableFrames !== endFrame - startFrame
    || shortfallFrames !== Math.max(0, requiredFrames - availableFrames)) {
    throw new Error("v2 声音时序冲突的范围或帧数事实不一致。");
  }
  return {
    version: NARRATION_FIT_CONFLICT_V2_VERSION,
    code: "NARRATION_GROUP_DOES_NOT_FIT_V2",
    groupId: safeId(conflict.groupId, "分段身份", 200),
    sourceRange: {
      baseGroupId: safeId(sourceRange.baseGroupId, "基础分段身份", 200),
      startCodePoint, endCodePoint,
    },
    sourceScenePositions: sourceScenePositions.map(Number),
    window: { startFrame, endFrame },
    placement: { anchor: placement.anchor, offsetFrames } as NarrationFitConflictV2["placement"],
    sourceSamples, requiredFrames, availableFrames, shortfallFrames,
    sourceOperationId: safeId(conflict.sourceOperationId, "原声音操作", 200),
    sourceContextId: safeId(conflict.sourceContextId, "来源上下文", 200),
    manifestArtifactId: safeId(conflict.manifestArtifactId, "来源清单产物", 200),
    manifestSha256: sha256Hex(conflict.manifestSha256, "来源清单摘要"),
  };
}

/** source.kind 穷尽分派：不靠 optional 字段堆出一个分不清来源的对象。 */
export function parseRelayoutSource(value: unknown): RelayoutNarrationSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("relayout 来源必须是对象。");
  }
  const source = value as Record<string, unknown>;
  if (source.kind === "voice_version") {
    return {
      kind: "voice_version",
      voiceVersionId: safeId(source.voiceVersionId, "声音版本"),
      voicePlanArtifactId: safeId(source.voicePlanArtifactId, "声音计划产物"),
      voicePlanSha256: sha256Hex(source.voicePlanSha256, "声音计划摘要"),
      expectedNarrationPlanSha256: sha256Hex(source.expectedNarrationPlanSha256, "期望旁白计划摘要"),
      expectedLayoutKey: safeId(source.expectedLayoutKey, "期望布局键"),
      expectedAudioSha256: sha256Hex(source.expectedAudioSha256, "期望音轨摘要"),
      sourceVoiceOperationId: safeId(source.sourceVoiceOperationId, "原声音操作"),
    };
  }
  if (source.kind === "materialized_operation") {
    return {
      kind: "materialized_operation",
      voiceInputVersionId: safeId(source.voiceInputVersionId, "声音输入版本"),
      sourceVoiceOperationId: safeId(source.sourceVoiceOperationId, "原声音操作"),
      sourceManifestArtifactId: safeId(source.sourceManifestArtifactId, "来源清单产物"),
      sourceManifestSha256: sha256Hex(source.sourceManifestSha256, "来源清单摘要"),
      sourceReceiptArtifactId: safeId(source.sourceReceiptArtifactId, "来源收据产物"),
    };
  }
  throw new Error("relayout 来源类型未知，拒绝分派。");
}

export function parseNarrationRelayoutRequest(value: unknown): NarrationRelayoutRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("旁白时间调整请求必须是对象。");
  }
  const draft = value as Record<string, unknown>;
  if (draft.action !== "relayout_narration") {
    throw new Error("不支持的旁白字幕操作。");
  }
  const requestId = safeId(draft.requestId, "请求身份");
  const expectedRunRevision = safeInt(draft.expectedRunRevision, "制作版本");
  if (draft.intent === "discard_unapplied") {
    const note = typeof draft.note === "string" ? draft.note.trim() : "";
    if (!note || note.length > 2_000) throw new Error("时间调整说明必须是 1–2000 字。");
    return {
      action: "relayout_narration", intent: "discard_unapplied", requestId, expectedRunRevision,
      targetRequestId: safeId(draft.targetRequestId, "目标请求身份"),
      note,
      interventionId: safeId(typeof draft.interventionId === "string" ? draft.interventionId : "", "停点身份"),
    };
  }
  if (draft.intent !== "apply") {
    throw new Error("时间调整意图未知。");
  }
  const note = typeof draft.note === "string" ? draft.note.trim() : "";
  if (!note || note.length > 2_000) throw new Error("时间调整说明必须是 1–2000 字。");
  const layout = draft.layout as Record<string, unknown> | undefined;
  if (!layout || typeof layout !== "object") throw new Error("时间调整缺少新布局。");
  const groups = layout.groups;
  if (!Array.isArray(groups) || !groups.length) throw new Error("新布局必须以原顺序列出全部分组。");
  for (const entry of groups as Array<Record<string, unknown>>) {
    const window = entry?.window as Record<string, unknown> | undefined;
    const placement = entry?.placement as Record<string, unknown> | undefined;
    if (typeof entry?.groupId !== "string" || !entry.groupId.trim()
      || !Number.isSafeInteger(window?.startFrame) || !Number.isSafeInteger(window?.endFrame)
      || (placement?.anchor !== "start" && placement?.anchor !== "end")
      || !Number.isSafeInteger(placement?.offsetFrames)) {
      throw new Error("新布局的分组、窗口或落点字段不完整。");
    }
  }
  const userSilences = layout.userSilences;
  if (!Array.isArray(userSilences)) throw new Error("新布局的显式留白必须是列表。");
  for (const silence of userSilences as Array<Record<string, unknown>>) {
    if (!Number.isSafeInteger(silence?.startFrame) || !Number.isSafeInteger(silence?.endFrame)) {
      throw new Error("显式留白必须是整数帧区间。");
    }
  }
  const layoutVersion = layout.narrationPlanVersion;
  if (layoutVersion !== "video-factory/narration-plan-v1" && layoutVersion !== "video-factory/narration-plan-v2") {
    throw new Error("新布局的计划版本未知。");
  }
  return {
    action: "relayout_narration", intent: "apply", requestId, expectedRunRevision,
    sourceContextId: safeId(draft.sourceContextId, "来源身份"),
    note,
    source: parseRelayoutSource(draft.source),
    layout: {
      narrationPlanVersion: layoutVersion,
      groups: (groups as Array<Record<string, unknown>>).map((entry) => ({
        groupId: entry.groupId as string,
        window: { startFrame: (entry.window as Record<string, unknown>).startFrame as number,
          endFrame: (entry.window as Record<string, unknown>).endFrame as number },
        placement: { anchor: (entry.placement as Record<string, unknown>).anchor as "start" | "end",
          offsetFrames: (entry.placement as Record<string, unknown>).offsetFrames as number },
      })),
      userSilences: (userSilences as Array<Record<string, unknown>>).map((silence) => ({
        startFrame: silence.startFrame as number, endFrame: silence.endFrame as number })),
    },
    interventionId: safeId(typeof draft.interventionId === "string" ? draft.interventionId : "", "停点身份"),
  };
}
