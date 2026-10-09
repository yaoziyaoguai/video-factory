import { useEffect, useRef, useState } from "react";
import { canonicalJsonV2, secondsToFramesV2 } from "@video-factory/production-pipeline/narration-text";
import type { SupportedNarrationPlan } from "@video-factory/production-pipeline";
import type {
  StudioArtifact,
  StudioNarrationPlanPreview,
  StudioNarrationRelayoutOperation,
  StudioNarrationRelayoutRequest,
  StudioNode,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

type GroupDraft = {
  groupId: string;
  windowStart: number;
  windowEnd: number;
  anchor: "start" | "end";
  offsetFrames: number;
};
type SourceSnapshot = {
  runId: string;
  revision: number;
  interventionId: string;
  sourceContextId: string;
  sourceIdentity: string;
};
type PendingEnvelope = {
  version: 1;
  sourceIdentity: string;
  request: StudioNarrationRelayoutRequest;
};
type TimingDraftStorage = {
  version: 1;
  sourceIdentity: string;
  groups: GroupDraft[];
  userSilences: Array<{ startFrame: number; endFrame: number }>;
  secondsInputs: Record<string, string>;
  pendingEnvelope?: PendingEnvelope;
};

const timingStorageKey = (runId: string) => `vf:narration-timing-draft:${runId}`;
const frameSeconds = (frames: number) => (frames / 30).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isConflictResolved = (marker: unknown) => marker === true || marker === "relayout";
const isFirstFitConflict = (code: unknown) => code === "NARRATION_GROUP_DOES_NOT_FIT_V2" || code === "NARRATION_TURN_DOES_NOT_FIT";

function voiceSourceDescriptor(voiceNode: StudioNode) {
  const output = isRecord(voiceNode.output) ? voiceNode.output : {};
  const receipt = isRecord(output.voiceSourceReceipt) ? output.voiceSourceReceipt : undefined;
  const conflict = isRecord(output.conflict) && !isConflictResolved(output.conflictResolved) ? output.conflict : undefined;
  return receipt && isFirstFitConflict(conflict?.code)
    ? { kind: "materialized_operation", input: receipt.voiceInputVersionId, operation: receipt.sourceOperationId,
        manifest: receipt.manifestArtifactId, receipt: receipt.receiptArtifactId }
    : { kind: "voice_version", version: voiceNode.outputState?.effectiveVersionId,
        layout: output.layoutKey, operation: output.voiceOperationId };
}

function sourceIdentity(runId: string, revision: number, interventionId: string, plan: SupportedNarrationPlan, voiceNode: StudioNode): string {
  return JSON.stringify({
    runId,
    revision,
    interventionId,
    sourceContextId: plan.version !== "video-factory/narration-plan-v1" ? plan.source.sourceContextId : "sc-legacy-v1",
    source: voiceSourceDescriptor(voiceNode),
  });
}

function initialGroups(plan: SupportedNarrationPlan): GroupDraft[] {
  return plan.groups.map((group) => ({
    groupId: group.id,
    windowStart: group.window.startFrame,
    windowEnd: group.window.endFrame,
    anchor: group.placement.anchor,
    offsetFrames: group.placement.offsetFrames,
  }));
}

function initialSeconds(groups: GroupDraft[], silences: Array<{ startFrame: number; endFrame: number }>): Record<string, string> {
  const values: Record<string, string> = {};
  groups.forEach((group, index) => {
    values[`w${index}s`] = frameSeconds(group.windowStart);
    values[`w${index}e`] = frameSeconds(group.windowEnd);
    values[`o${index}`] = frameSeconds(group.offsetFrames);
  });
  silences.forEach((silence, index) => {
    values[`s${index}s`] = frameSeconds(silence.startFrame);
    values[`s${index}e`] = frameSeconds(silence.endFrame);
  });
  return values;
}

function draftSignature(groups: GroupDraft[], silences: Array<{ startFrame: number; endFrame: number }>, seconds: Record<string, string>) {
  return JSON.stringify({ groups, silences, seconds });
}

function readTimingDraft(runId: string, identity: string): { draft?: TimingDraftStorage; warning?: string } {
  try {
    const raw = window.localStorage.getItem(timingStorageKey(runId));
    if (!raw) return {};
    const draft = JSON.parse(raw) as Partial<TimingDraftStorage>;
    if (draft.version !== 1 || draft.sourceIdentity !== identity || !Array.isArray(draft.groups)
      || !Array.isArray(draft.userSilences) || !draft.secondsInputs) {
      return { warning: "找到另一版声音来源的本地草稿；它仅保留为参考，不能提交到当前版本。" };
    }
    return { draft: draft as TimingDraftStorage };
  } catch {
    return { warning: "无法读取本机时间草稿；当前页面仍可编辑，刷新前请复制留存。" };
  }
}

/**
 * 折叠摘要用的展示状态（CLOUD-03）：只上报“有没有事”这类标志，不复制命令身份——
 * 请求编号、版本与恢复语义仍唯一保存在本组件内。
 */
export interface NarrationTimingToolSummary {
  dirty: boolean;
  pending: boolean;
  error: boolean;
  storageFailed: boolean;
  busy: boolean;
  conflict: boolean;
  stale: boolean;
}

/** 生成后只调窗口、落点和显式留白；文本、音色、分组和原声音来源保持不变。 */
export function NarrationTimingEditor({ runId, revision, voiceNode, artifacts, interventionId, disabled, onStateSummary }: {
  runId: string;
  revision: number;
  voiceNode: StudioNode;
  artifacts: StudioArtifact[];
  interventionId: string;
  disabled: boolean;
  onStateSummary?: (summary: NarrationTimingToolSummary) => void;
}) {
  const [plan, setPlan] = useState<SupportedNarrationPlan>();
  const [characters, setCharacters] = useState<Array<{ id: string; name: string }>>([]);
  const [groups, setGroups] = useState<GroupDraft[]>([]);
  const [userSilences, setUserSilences] = useState<Array<{ startFrame: number; endFrame: number }>>([]);
  const [secondsInputs, setSecondsInputs] = useState<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState<SourceSnapshot>();
  const [baseline, setBaseline] = useState<string>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [storageWarning, setStorageWarning] = useState<string>();
  const [pendingEnvelope, setPendingEnvelope] = useState<PendingEnvelope>();
  const [operation, setOperation] = useState<StudioNarrationRelayoutOperation>();
  const [busyToken, setBusyToken] = useState<string>();
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const reloadDialogRef = useDialogFocus<HTMLElement>(reloadPrompt, () => setReloadPrompt(false), Boolean(busyToken));
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const requestSerial = useRef(0);
  const activeRequest = useRef<string | undefined>(undefined);
  const voiceSourceKey = JSON.stringify(voiceSourceDescriptor(voiceNode));
  const currentProps = useRef({ runId, revision, interventionId, voiceSourceKey });
  currentProps.current = { runId, revision, interventionId, voiceSourceKey };
  const currentDraftSignature = draftSignature(groups, userSilences, secondsInputs);
  const dirty = baseline !== undefined && currentDraftSignature !== baseline;
  const liveSourceIdentity = plan ? sourceIdentity(runId, revision, interventionId, plan, voiceNode) : undefined;
  const liveSourceIdentityRef = useRef(liveSourceIdentity);
  liveSourceIdentityRef.current = liveSourceIdentity;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const pendingEnvelopeRef = useRef(pendingEnvelope);
  pendingEnvelopeRef.current = pendingEnvelope;
  // 用户已明确放弃旧稿、等待下一次读取当前事实的一次性意图；新来源接纳成功前保持。
  const discardingDraftRef = useRef(false);
  // 清理失败时，本页不再恢复该 run 已被明确放弃的副本；新编辑写入成功才解除。
  const ignoredDraftRunRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const token = `load:${runId}:${revision}:${interventionId}:${voiceSourceKey}:${++requestSerial.current}`;
    activeRequest.current = token;
    setBusyToken(token);
    let cancelled = false;
    (async () => {
      try {
        const response: StudioNarrationPlanPreview = await studioApi.narrationPlan(runId);
        const isCurrentLoad = () => {
          const props = currentProps.current;
          return !cancelled && activeRequest.current === token && props.runId === runId && props.revision === revision
            && props.interventionId === interventionId && props.voiceSourceKey === voiceSourceKey;
        };
        if (!isCurrentLoad()) return;
        const identity = sourceIdentity(runId, revision, interventionId, response.plan, voiceNode);
        let appliedOperation: StudioNarrationRelayoutOperation | undefined;
        const pending = pendingEnvelopeRef.current;
        // SSE可能先于POST响应带回本次新声音。只查询原请求，并核对当前有效版本；
        // 其他标签/其他请求的版本变更仍保留旧草稿，绝不把迟到响应套到新版本。
        if (pending && snapshot?.runId === runId && snapshot.sourceIdentity !== identity) {
          try {
            const receipt = await studioApi.narrationRelayoutOperation(runId, pending.request.requestId);
            if (!isCurrentLoad()) return;
            if (receipt.requestId === pending.request.requestId && receipt.state === "applied" && receipt.isCurrent
              && receipt.resultVoiceVersionId === voiceNode.outputState?.effectiveVersionId
              && receipt.resultVoiceVersionId && /^[a-f0-9]{64}$/u.test(receipt.requestDigest ?? "")) {
              appliedOperation = receipt;
            }
          } catch { /* 查询失败仍按旧草稿处理，不推断成功，也不重发。 */ }
          if (!isCurrentLoad()) return;
        }
        if (!discardingDraftRef.current && (dirtyRef.current || pendingEnvelopeRef.current)
          && snapshot?.sourceIdentity && snapshot.sourceIdentity !== identity && !appliedOperation) {
          setStatus("制作记录或声音版本已更新。旧草稿保持只读，请先决定是否放弃并重新读取。");
          return;
        }
        const baseGroups = initialGroups(response.plan);
        const baseSilences = response.plan.version !== "video-factory/narration-plan-v1"
          ? response.plan.silences.filter((item) => item.source === "user")
            .map((item) => ({ startFrame: item.startFrame, endFrame: item.endFrame })) : [];
        const baseSeconds = initialSeconds(baseGroups, baseSilences);
        const ignoreStoredDraft = discardingDraftRef.current || ignoredDraftRunRef.current === runId || Boolean(appliedOperation);
        const stored = ignoreStoredDraft ? {} : readTimingDraft(runId, identity);
        setPlan(response.plan);
        setCharacters(response.editorContext?.characters ?? []);
        setSnapshot({ runId, revision, interventionId,
          sourceContextId: response.plan.version !== "video-factory/narration-plan-v1" ? response.plan.source.sourceContextId : "sc-legacy-v1",
          sourceIdentity: identity });
        setBaseline(draftSignature(baseGroups, baseSilences, baseSeconds));
        setGroups(stored.draft?.groups ?? baseGroups);
        setUserSilences(stored.draft?.userSilences ?? baseSilences);
        setSecondsInputs(stored.draft?.secondsInputs ?? baseSeconds);
        setPendingEnvelope(stored.draft?.pendingEnvelope);
        if (ignoredDraftRunRef.current !== runId) setStorageWarning(stored.warning);
        setError(undefined);
        setStatus(appliedOperation ? "已用原配音完成本地时间调整（未重新购买）。请试听新声音；确认后才继续渲染。" : undefined);
        if (appliedOperation) {
          setOperation(appliedOperation);
          try { window.localStorage.removeItem(timingStorageKey(runId)); } catch {
            setStorageWarning("服务端已采用新声音；本机旧草稿未能清理，下次先按服务端版本对账。");
          }
        }
        setReloadPrompt(false);
        discardingDraftRef.current = false;
      } catch (caught) {
        if (!cancelled && activeRequest.current === token) {
          setError(caught instanceof Error ? caught.message : "当前声音方案读取失败，请稍后再试。");
        }
      } finally {
        if (!cancelled && activeRequest.current === token) {
          activeRequest.current = undefined;
          setBusyToken(undefined);
        }
      }
    })();
    return () => { cancelled = true; };
    // voice source identity is intentionally part of the load boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, revision, interventionId, voiceSourceKey, reloadGeneration]);

  const currentVoiceVersion = voiceNode.outputState?.effectiveVersionId;
  const stale = Boolean(snapshot && snapshot.sourceIdentity !== liveSourceIdentity);
  const editableWindows = plan?.version === "video-factory/narration-plan-v2" || plan?.version === "video-factory/narration-plan-v3";
  const outputRecord = isRecord(voiceNode.output) ? voiceNode.output : {};
  const outputConflict = isRecord(outputRecord.conflict) && !isConflictResolved(outputRecord.conflictResolved) ? outputRecord.conflict : undefined;
  const receipt = isRecord(outputRecord.voiceSourceReceipt) ? outputRecord.voiceSourceReceipt : undefined;

  // 折叠时摘要处仍要显露未决操作/未保存修改（CLOUD-03）；仅展示标志，不搬运命令状态。
  useEffect(() => {
    onStateSummary?.({
      dirty,
      pending: Boolean(pendingEnvelope),
      error: Boolean(error),
      storageFailed: Boolean(storageWarning),
      busy: Boolean(busyToken),
      conflict: Boolean(outputConflict),
      stale,
    });
  }, [dirty, pendingEnvelope, error, storageWarning, busyToken, outputConflict, stale, onStateSummary]);

  const listenArtifacts = (() => {
    if (receipt && isFirstFitConflict(outputConflict?.code) && Array.isArray(receipt.groupAudioArtifacts)) {
      const ids = receipt.groupAudioArtifacts.flatMap((item) => isRecord(item) && typeof item.artifactId === "string" ? [item.artifactId] : []);
      return ids.flatMap((id) => artifacts.find((artifact) => artifact.id === id) ?? []);
    }
    const version = voiceNode.outputState?.versions.find((candidate) => candidate.id === currentVoiceVersion);
    return version ? artifacts.filter((artifact) => version.artifactIds.includes(artifact.id) && artifact.kind === "voiceover") : [];
  })();

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty && !pendingEnvelope) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, pendingEnvelope]);

  useEffect(() => {
    if (!snapshot) return;
    if (discardingDraftRef.current) return; // 明确放弃后、新来源接纳前，不把旧稿写回本机。
    const stored: TimingDraftStorage = { version: 1, sourceIdentity: snapshot.sourceIdentity,
      groups, userSilences, secondsInputs, ...(pendingEnvelope ? { pendingEnvelope } : {}) };
    try {
      if (dirty || pendingEnvelope) {
        window.localStorage.setItem(timingStorageKey(runId), JSON.stringify(stored));
        if (ignoredDraftRunRef.current === runId) {
          ignoredDraftRunRef.current = undefined;
          setStorageWarning(undefined);
        }
      } else window.localStorage.removeItem(timingStorageKey(runId));
    } catch {
      if (dirty || pendingEnvelope) setStorageWarning("本机草稿保存失败；当前页面仍保留输入。刷新前请复制留存，未决请求会沿页面内同一编号继续。");
    }
  }, [dirty, groups, pendingEnvelope, runId, secondsInputs, snapshot, userSilences]);

  const markEdited = () => {
    setStatus(undefined);
    setError(undefined);
  };
  const changeSeconds = (key: string, value: string) => {
    setSecondsInputs((current) => ({ ...current, [key]: value }));
    markEdited();
  };
  const quantize = (key: string, apply: (frames: number) => void) => {
    try {
      const frames = secondsToFramesV2(secondsInputs[key] ?? "");
      apply(frames);
      setSecondsInputs((current) => ({ ...current, [key]: frameSeconds(frames) }));
      setError(undefined);
    } catch {
      setError("时间请输入非负十进制秒（至多 6 位小数）；非法输入不会退回旧帧提交。");
    }
  };

  /** 删除留白时同步迁移其未提交的原始秒字符串；剩余留白不能继承已删除项的 s* 键。 */
  const removeSilenceAt = (index: number) => {
    const remaining = userSilences.filter((_, position) => position !== index);
    setUserSilences(remaining);
    setSecondsInputs((current) => {
      const next: Record<string, string> = {};
      Object.entries(current).forEach(([key, value]) => {
        if (/^s\d+[se]$/u.test(key)) return; // 先移除全部旧 s* 键，再按原索引到新索引迁移。
        next[key] = value;
      });
      remaining.forEach((silence, position) => {
        const sourceIndex = position >= index ? position + 1 : position;
        next[`s${position}s`] = current[`s${sourceIndex}s`] ?? frameSeconds(silence.startFrame);
        next[`s${position}e`] = current[`s${sourceIndex}e`] ?? frameSeconds(silence.endFrame);
      });
      return next;
    });
    markEdited();
  };

  const materialize = () => {
    if (!plan) throw new Error("当前声音方案尚未读取完成。");
    const resolvedGroups = groups.map((group, index) => {
      const windowStart = editableWindows ? secondsToFramesV2(secondsInputs[`w${index}s`] ?? frameSeconds(group.windowStart)) : group.windowStart;
      const windowEnd = editableWindows ? secondsToFramesV2(secondsInputs[`w${index}e`] ?? frameSeconds(group.windowEnd)) : group.windowEnd;
      const offsetFrames = secondsToFramesV2(secondsInputs[`o${index}`] ?? frameSeconds(group.offsetFrames));
      if (windowEnd <= windowStart || offsetFrames >= windowEnd - windowStart) {
        throw new Error(`第 ${index + 1} 段的结束时间必须晚于开始时间，且段内留空必须小于窗口。`);
      }
      return { ...group, windowStart, windowEnd, offsetFrames };
    });
    const silences = userSilences.map((silence, index) => {
      const startFrame = secondsToFramesV2(secondsInputs[`s${index}s`] ?? frameSeconds(silence.startFrame));
      const endFrame = secondsToFramesV2(secondsInputs[`s${index}e`] ?? frameSeconds(silence.endFrame));
      if (endFrame <= startFrame) throw new Error(`留白 ${index + 1} 的结束时间必须晚于开始时间。`);
      return { startFrame, endFrame };
    });
    return { groups: resolvedGroups, userSilences: silences };
  };

  const buildEnvelope = async (): Promise<PendingEnvelope> => {
    if (!plan || !snapshot) throw new Error("当前声音来源尚未读取完成。");
    const resolved = materialize();
    const requestId = `relayout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const common = {
      action: "relayout_narration" as const,
      intent: "apply" as const,
      requestId,
      expectedRunRevision: revision,
      interventionId,
      sourceContextId: snapshot.sourceContextId,
      layout: {
        narrationPlanVersion: plan.version,
        groups: resolved.groups.map((group) => {
          const original = plan.groups.find((item) => item.id === group.groupId)!;
          return { groupId: group.groupId,
            window: editableWindows ? { startFrame: group.windowStart, endFrame: group.windowEnd } : { ...original.window },
            placement: { anchor: group.anchor, offsetFrames: group.offsetFrames } };
        }),
        userSilences: editableWindows ? resolved.userSilences : [],
      },
    };
    let request: StudioNarrationRelayoutRequest;
    if (receipt && isFirstFitConflict(outputConflict?.code)) {
      const manifest = artifacts.find((artifact) => artifact.id === receipt.manifestArtifactId);
      const receiptArtifact = artifacts.find((artifact) => artifact.id === receipt.receiptArtifactId);
      if (!manifest || !receiptArtifact || typeof receipt.voiceInputVersionId !== "string"
        || typeof receipt.sourceOperationId !== "string" || typeof receipt.manifestSha256 !== "string") {
        throw new Error("首次配音来源留档不完整，暂不能只调整时间；原音频仍可试听。");
      }
      request = { ...common, note: "首次放不下后的时间调整（复用原配音）",
        source: { kind: "materialized_operation", voiceInputVersionId: receipt.voiceInputVersionId,
          sourceVoiceOperationId: receipt.sourceOperationId, sourceManifestArtifactId: manifest.id,
          sourceManifestSha256: receipt.manifestSha256, sourceReceiptArtifactId: receiptArtifact.id } };
    } else {
      const version = voiceNode.outputState?.versions.find((candidate) => candidate.id === currentVoiceVersion);
      const planArtifact = version && artifacts.find((artifact) => version.artifactIds.includes(artifact.id) && artifact.kind === "voiceover_plan");
      const audioArtifact = version && artifacts.find((artifact) => version.artifactIds.includes(artifact.id) && artifact.kind === "voiceover");
      if (!version || !planArtifact || !audioArtifact || typeof outputRecord.layoutKey !== "string"
        || typeof outputRecord.voiceOperationId !== "string") {
        throw new Error("当前声音版本或来源不完整，暂不能只调整时间；原声音仍可试听与确认。");
      }
      request = { ...common, note: "只调整配音时间（复用原配音）",
        source: { kind: "voice_version", voiceVersionId: version.id, voicePlanArtifactId: planArtifact.id,
          voicePlanSha256: planArtifact.sha256 ?? "", expectedNarrationPlanSha256: await canonicalDigest(plan),
          expectedLayoutKey: outputRecord.layoutKey, expectedAudioSha256: audioArtifact.sha256 ?? "",
          sourceVoiceOperationId: outputRecord.voiceOperationId } };
    }
    return { version: 1, sourceIdentity: snapshot.sourceIdentity, request };
  };

  const persistEnvelope = (envelope: PendingEnvelope) => {
    setPendingEnvelope(envelope);
    if (!snapshot) return;
    try {
      window.localStorage.setItem(timingStorageKey(runId), JSON.stringify({
        version: 1, sourceIdentity: snapshot.sourceIdentity, groups, userSilences, secondsInputs, pendingEnvelope: envelope,
      } satisfies TimingDraftStorage));
    } catch {
      setStorageWarning("未决请求只能保留在当前页面；请勿刷新。继续操作会沿同一请求编号，不会换号重发。");
    }
  };

  const verifyOperation = (candidate: StudioNarrationRelayoutOperation, expectedEnvelope?: PendingEnvelope) => {
    if (expectedEnvelope && candidate.requestId !== expectedEnvelope.request.requestId) {
      throw new Error("服务端返回的时间调整编号与当前未决请求不一致。");
    }
    if (candidate.state === "applied") {
      if (!candidate.isCurrent || !candidate.resultVoiceVersionId || !candidate.requestDigest
        || !/^[a-f0-9]{64}$/u.test(candidate.requestDigest)) {
        throw new Error("服务端尚未证明新声音版本已经采用；请求保留待对账。");
      }
      setStatus("已用原配音完成本地时间调整（未重新购买）。请试听新声音；确认后才继续渲染。");
      setOperation(candidate);
      setPendingEnvelope(undefined);
      setBaseline(currentDraftSignature);
      try { window.localStorage.removeItem(timingStorageKey(runId)); } catch {
        setStorageWarning("服务端已采用新声音；本机旧草稿未能清理，下次先按服务端版本对账。");
      }
      return true;
    }
    setOperation(candidate);
    return false;
  };

  const applyTiming = async () => {
    if (!plan || !snapshot || stale || busyToken || activeRequest.current || disabled) return;
    // 首次查询或摘要之前就占用动作，整个请求只能更新最初捕获的声音来源。
    const token = `apply:${++requestSerial.current}`;
    const requestSourceIdentity = snapshot.sourceIdentity;
    const isCurrent = () => activeRequest.current === token && liveSourceIdentityRef.current === requestSourceIdentity;
    activeRequest.current = token;
    setBusyToken(token);
    setError(undefined);
    let envelope = pendingEnvelope;
    let dispatched = false;
    try {
      if (envelope && envelope.sourceIdentity !== snapshot.sourceIdentity) {
        throw new Error("未决请求属于另一版声音，不能套到当前版本；请保留参考并重新读取。");
      }
      if (envelope) {
        try {
          const current = await studioApi.narrationRelayoutOperation(runId, envelope.request.requestId);
          if (!isCurrent()) return;
          if (verifyOperation(current, envelope)) return;
          if (current.state === "failed") throw new Error(current.failureReason ?? "这次时间调整未生效；请修改布局或撤销旧意图。");
          if (current.state === "discarded") {
            setPendingEnvelope(undefined);
            throw new Error("旧时间调整已撤销；请检查当前草稿后发起新请求。");
          }
        } catch (caught) {
          if (!isCurrent()) return;
          if (caught instanceof Error && !/没有这条时间调整/u.test(caught.message)) throw caught;
        }
      } else {
        envelope = await buildEnvelope();
        if (!isCurrent()) return;
        persistEnvelope(envelope);
      }
      if (!isCurrent()) return;
      dispatched = true;
      await studioApi.requestNarrationRevision(runId, envelope.request);
      if (!isCurrent()) return;
      const current = await studioApi.narrationRelayoutOperation(runId, envelope.request.requestId);
      if (!isCurrent()) return;
      if (!verifyOperation(current, envelope)) setStatus("时间调整已受理，正在本地处理；会继续沿同一请求编号，不会重新购买声音。");
    } catch (caught) {
      if (isCurrent()) {
        setError(caught instanceof Error ? caught.message : dispatched
          ? "时间调整结果未知；草稿与原请求编号已保留，请先查询后继续。" : "时间调整输入无效。");
        if (!dispatched || !envelope) return;
        try {
          const current = await studioApi.narrationRelayoutOperation(runId, envelope.request.requestId);
          if (isCurrent()) verifyOperation(current, envelope);
        } catch { /* 原请求仍保留，不能以查询失败改成新请求。 */ }
      }
    } finally {
      if (isCurrent()) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  };

  const discardUnapplied = async () => {
    const target = pendingEnvelope?.request.requestId ?? operation?.requestId;
    if (!target || operation?.state === "applied" || busyToken || disabled) return;
    const token = `discard:${target}:${++requestSerial.current}`;
    activeRequest.current = token;
    setBusyToken(token);
    try {
      await studioApi.requestNarrationRevision(runId, {
        action: "relayout_narration", intent: "discard_unapplied", requestId: `discard-${target}`,
        expectedRunRevision: revision, interventionId, targetRequestId: target, note: "撤销未生效的时间调整",
      });
      if (activeRequest.current === token) {
        setStatus("已撤销未生效的时间调整；原声音与当前停点保持不变。");
        setOperation(undefined);
        setPendingEnvelope(undefined);
      }
    } catch (caught) {
      if (activeRequest.current === token) setError(caught instanceof Error ? caught.message : "撤销没有完成，请稍后重试。");
    } finally {
      if (activeRequest.current === token) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  };

  const reloadCurrent = () => {
    if ((dirty || pendingEnvelope) && !discardingDraftRef.current) {
      setReloadPrompt(true);
      return;
    }
    setReloadGeneration((value) => value + 1);
  };

  if (!plan) return <section className="node-preview-section narration-timing-editor" aria-label="只调整配音时间">
    <h3>只调整配音时间</h3>
    {error ? <p className="error-message" role="alert">{error}</p> : <p>正在读取当前声音方案…</p>}
  </section>;

  const sourceVersion = voiceNode.outputState?.versions.find(version => version.id === currentVoiceVersion);
  const sourceTracked = receipt && isFirstFitConflict(outputConflict?.code)
    ? typeof receipt.sourceOperationId === "string" && typeof receipt.manifestArtifactId === "string"
    : sourceVersion && typeof outputRecord.layoutKey === "string" && typeof outputRecord.voiceOperationId === "string"
      && ["voiceover_plan", "voiceover"].every(kind => artifacts.some(artifact => artifact.kind === kind && sourceVersion.artifactIds.includes(artifact.id)));
  if (!sourceTracked && !pendingEnvelope && !dirty && !stale) return <section className="node-preview-section narration-timing-editor" aria-label="只调整配音时间">
    <h3>这版声音暂不支持只调整时间</h3>
    <p role="status">这版声音没有可核对的排轨来源，无法保证调整时复用原配音，因此不提供无效的编辑控件。原声音仍可试听与采用；如需改词或重做声音，请使用返工入口，费用由你另行确认。</p>
    {storageWarning ? <p>{storageWarning}</p> : null}
  </section>;

  const locked = Boolean(busyToken) || disabled || stale || !sourceTracked;
  return <section className="node-preview-section narration-timing-editor" aria-label="只调整配音时间">
    <h3>只调整配音时间</h3>
    <p>复用原配音，本地调整窗口、落点和明确留白；不重新购买、不改文本、不改音色、不改变画面总时长。完成后停在声音试听，由你确认才继续渲染。</p>
    {outputConflict ? <p role="alert">上一段放不下：需要 {String(outputConflict.requiredFrames)} 帧，当前窗口只有 {String(outputConflict.availableFrames)} 帧。可扩大窗口或调整显式留白。</p> : null}
    {listenArtifacts.length ? <p>原声试听：{listenArtifacts.map((artifact) => <audio key={artifact.id} controls preload="none"
      src={`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifact.id)}/content`} />)}</p> :
      <p role="status">当前没有受核的可试听音轨；不能批准不存在的声音，请先核对首次配音来源。</p>}
    {groups.map((group, index) => {
      const original = plan.groups.find((candidate) => candidate.id === group.groupId)!;
      return <fieldset key={group.groupId} disabled={locked}>
        <legend>{"speakerId" in original ? `台词 ${index + 1} · ${characters.find((item) => item.id === original.speakerId)?.name ?? "角色"}` : `第 ${index + 1} 段`} · 镜头 {original.sourceScenePositions.join("、")}</legend>
        <p>{original.text}</p>
        {editableWindows ? <>
          <label className="field"><span>窗口开始（秒）</span><input type="text" inputMode="decimal" aria-label={`第 ${index + 1} 段窗口开始秒`}
            value={secondsInputs[`w${index}s`] ?? frameSeconds(group.windowStart)} onChange={(event) => changeSeconds(`w${index}s`, event.target.value)}
            onBlur={() => quantize(`w${index}s`, (frames) => setGroups((current) => current.map((item, position) => position === index ? { ...item, windowStart: frames } : item)))} /></label>
          <label className="field"><span>窗口结束（秒）</span><input type="text" inputMode="decimal" aria-label={`第 ${index + 1} 段窗口结束秒`}
            value={secondsInputs[`w${index}e`] ?? frameSeconds(group.windowEnd)} onChange={(event) => changeSeconds(`w${index}e`, event.target.value)}
            onBlur={() => quantize(`w${index}e`, (frames) => setGroups((current) => current.map((item, position) => position === index ? { ...item, windowEnd: frames } : item)))} /></label>
        </> : <small>v1 只允许整组移动；要重新分段或改词，需回到生成前并重新配音。</small>}
        <label className="field"><span>声音落点</span><select aria-label={`第 ${index + 1} 段落点`} value={group.anchor}
          onChange={(event) => { setGroups((current) => current.map((item, position) => position === index ? { ...item, anchor: event.target.value === "end" ? "end" : "start" } : item)); markEdited(); }}>
          <option value="start">从这一段开头说起</option><option value="end">贴近这一段结尾说完</option>
        </select></label>
        <label className="field"><span>向段内留空（秒）</span><input type="text" inputMode="decimal" aria-label={`第 ${index + 1} 段留空秒`}
          value={secondsInputs[`o${index}`] ?? frameSeconds(group.offsetFrames)} onChange={(event) => changeSeconds(`o${index}`, event.target.value)}
          onBlur={() => quantize(`o${index}`, (frames) => setGroups((current) => current.map((item, position) => position === index ? { ...item, offsetFrames: frames } : item)))} /></label>
      </fieldset>;
    })}
    {editableWindows ? <fieldset disabled={locked}>
      <legend>显式留白</legend>
      {userSilences.map((silence, index) => <div key={index} className="narration-silence-inputs">
        <label className="field"><span>留白 {index + 1} 开始（秒）</span><input type="text" inputMode="decimal" aria-label={`留白 ${index + 1} 开始秒`}
          value={secondsInputs[`s${index}s`] ?? frameSeconds(silence.startFrame)} onChange={(event) => changeSeconds(`s${index}s`, event.target.value)}
          onBlur={() => quantize(`s${index}s`, (frames) => setUserSilences((current) => current.map((item, position) => position === index ? { ...item, startFrame: frames } : item)))} /></label>
        <label className="field"><span>留白 {index + 1} 结束（秒）</span><input type="text" inputMode="decimal" aria-label={`留白 ${index + 1} 结束秒`}
          value={secondsInputs[`s${index}e`] ?? frameSeconds(silence.endFrame)} onChange={(event) => changeSeconds(`s${index}e`, event.target.value)}
          onBlur={() => quantize(`s${index}e`, (frames) => setUserSilences((current) => current.map((item, position) => position === index ? { ...item, endFrame: frames } : item)))} /></label>
        <button type="button" className="button button-secondary" onClick={() => removeSilenceAt(index)}>移除留白</button>
      </div>)}
      <button type="button" className="button button-secondary" onClick={() => {
        const index = userSilences.length;
        setUserSilences((current) => [...current, { startFrame: 0, endFrame: 1 }]);
        setSecondsInputs((current) => ({ ...current, [`s${index}s`]: "0", [`s${index}e`]: frameSeconds(1) }));
        markEdited();
      }}>添加留白</button>
    </fieldset> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {status ? <p role="status">{status}</p> : null}
    {storageWarning ? <p role="status">{storageWarning}</p> : null}
    {stale ? <p role="status">制作记录、声音版本或确认点已更新；旧草稿只读，不能提交到新版本。</p> : null}
    {reloadPrompt ? <div className="dialog-backdrop" role="presentation"><section ref={reloadDialogRef}
      className="decision-dialog" role="alertdialog" aria-modal="true" tabIndex={-1} aria-label="放弃时间草稿并重新读取">
      <p>当前有未保存修改或未决请求。重新读取会放弃本页草稿；服务端已受理的请求仍以原编号为准。</p>
      <footer className="dialog-actions"><button type="button" className="button button-secondary" data-dialog-initial-focus onClick={() => setReloadPrompt(false)}>返回继续编辑</button>
      <button type="button" className="button button-danger" onClick={() => {
        discardingDraftRef.current = true;
        try {
          window.localStorage.removeItem(timingStorageKey(runId));
          ignoredDraftRunRef.current = undefined;
        } catch {
          ignoredDraftRunRef.current = runId;
          setStorageWarning("本机旧草稿未能清理；本页不再恢复已放弃的副本，刷新前请确认本机存储可用。");
        }
        setPendingEnvelope(undefined); setOperation(undefined); setReloadPrompt(false); setStatus(undefined);
        setReloadGeneration((value) => value + 1);
      }}>放弃草稿并重新读取</button></footer>
    </section></div> : null}
    <button type="button" className="button button-secondary" disabled={Boolean(busyToken)} onClick={reloadCurrent}>重新读取当前版本</button>
    <button type="button" className="button button-primary" disabled={locked || !listenArtifacts.length} onClick={() => void applyTiming()}>
      {pendingEnvelope ? "继续此时间调整" : "应用时间调整并重新试听"}</button>
    {(operation && operation.state !== "applied") || pendingEnvelope
      ? <button type="button" className="button button-secondary" disabled={locked} onClick={() => void discardUnapplied()}>撤销这次未生效的修改</button> : null}
    {baseline && dirty ? <p role="status">时间草稿尚未生效。</p> : null}
  </section>;
}

async function canonicalDigest(plan: SupportedNarrationPlan): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJsonV2(plan));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
