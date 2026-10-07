import { useEffect, useRef, useState } from "react";
import { secondsToFramesV2 } from "@video-factory/production-pipeline/narration-text";
import type { StudioNarrationPlanPreview, StudioNarrationPreviewTicketV2, StudioRunDetail } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

type BaseGroup = StudioNarrationPlanPreview["editorContext"]["baseGroups"][number];
type CandidateGroup = {
  sourceRange: { baseGroupId: string; startCodePoint: number; endCodePoint: number };
  window: { startFrame: number; endFrame: number };
  placement: { anchor: "start" | "end"; offsetFrames: number };
};
type WindowDraft = CandidateGroup["window"] & CandidateGroup["placement"];
type SegmentationDraft = {
  version: 1;
  sourceContextId: string;
  boundaries: Record<string, number[]>;
  windows: Record<string, WindowDraft>;
  seconds: Record<string, string>;
  userSilences: Array<{ startFrame: number; endFrame: number }>;
  silenceSeconds: Array<{ start: string; end: string }>;
  generation: number;
};
type SegmentationReloadGuard = {
  dirty: boolean;
  pending: boolean;
  saving: boolean;
  discard(): void;
};

const segmentationStorageKey = (runId: string) => `vf:narration-plan-draft:${runId}`;
const frameSeconds = (frames: number) => (frames / 30).toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
const windowKey = (baseGroupId: string, startCodePoint: number) => `w:${baseGroupId}:${startCodePoint}`;

// 仅复用窗口控件的视图模型；v3 不接受句界拆分，发送时仍是独立 turnId 合同。
function editorBaseGroups(preview: StudioNarrationPlanPreview): BaseGroup[] {
  if (preview.plan.version !== "video-factory/narration-plan-v3") return preview.editorContext.baseGroups;
  return preview.plan.groups.map((group) => ({ baseGroupId: group.turnId, text: group.text,
    endCodePoint: Array.from(group.text).length, frameRange: group.window, allowedBoundaries: [] }));
}
const draftStorage = (preview: StudioNarrationPlanPreview) =>
  preview.plan.version === "video-factory/narration-plan-v3" ? window.sessionStorage : window.localStorage;

function initialSegmentationDraft(preview: StudioNarrationPlanPreview): SegmentationDraft {
  const boundaries: Record<string, number[]> = {};
  const windows: Record<string, WindowDraft> = {};
  const seconds: Record<string, string> = {};
  const plan = preview.editorContext.savedPlanStatus === "current"
    && preview.plan.version === "video-factory/narration-plan-v2" ? preview.plan : undefined;
  for (const base of editorBaseGroups(preview)) {
    const saved = plan?.groups.filter((group) => group.sourceRange.baseGroupId === base.baseGroupId) ?? [];
    boundaries[base.baseGroupId] = saved.slice(0, -1).map((group) => group.sourceRange.endCodePoint);
    const character = preview.plan.version === "video-factory/narration-plan-v3"
      ? preview.plan.groups.find((group) => group.turnId === base.baseGroupId) : undefined;
    const groups = saved.length ? saved : [{
      sourceRange: { baseGroupId: base.baseGroupId, startCodePoint: 0, endCodePoint: base.endCodePoint },
      window: character?.window ?? base.frameRange,
      placement: character?.placement ?? { anchor: "start" as const, offsetFrames: 0 },
    }];
    for (const group of groups) {
      const key = windowKey(base.baseGroupId, group.sourceRange.startCodePoint);
      windows[key] = { ...group.window, ...group.placement };
      seconds[`${key}:start`] = frameSeconds(group.window.startFrame);
      seconds[`${key}:end`] = frameSeconds(group.window.endFrame);
      seconds[`${key}:offset`] = frameSeconds(group.placement.offsetFrames);
    }
  }
  const silencePlan = preview.plan.version === "video-factory/narration-plan-v3" ? preview.plan : plan;
  const userSilences = silencePlan?.silences.filter((item) => item.source === "user")
    .map((item) => ({ startFrame: item.startFrame, endFrame: item.endFrame })) ?? [];
  return {
    version: 1,
    sourceContextId: preview.sourceContextId ?? "",
    boundaries,
    windows,
    seconds,
    userSilences,
    silenceSeconds: userSilences.map((silence) => ({
      start: frameSeconds(silence.startFrame),
      end: frameSeconds(silence.endFrame),
    })),
    generation: 0,
  };
}

function readSegmentationDraft(runId: string, preview: StudioNarrationPlanPreview): { draft: SegmentationDraft; warning?: string } {
  const fallback = initialSegmentationDraft(preview);
  try {
    const raw = draftStorage(preview).getItem(segmentationStorageKey(runId));
    if (!raw) return { draft: fallback };
    const stored = JSON.parse(raw) as Partial<SegmentationDraft>;
    if (stored.version !== 1 || stored.sourceContextId !== preview.sourceContextId
      || !stored.boundaries || !stored.windows || !stored.seconds || !Array.isArray(stored.userSilences)) {
      return { draft: fallback, warning: "找到另一版来源的本地草稿；它不会覆盖当前方案。" };
    }
    const silenceSeconds = Array.isArray(stored.silenceSeconds)
      && stored.silenceSeconds.length === stored.userSilences.length
      ? stored.silenceSeconds as Array<{ start: string; end: string }>
      : stored.userSilences.map((silence) => ({ start: frameSeconds(silence.startFrame!), end: frameSeconds(silence.endFrame!) }));
    return { draft: { ...stored, silenceSeconds } as SegmentationDraft };
  } catch {
    return { draft: fallback, warning: "无法读取本机旁白草稿；本页仍可编辑，刷新前请复制留存。" };
  }
}

function candidateGroups(baseGroups: BaseGroup[], draft: SegmentationDraft): CandidateGroup[] {
  return baseGroups.flatMap((base) => {
    const cuts = [0, ...(draft.boundaries[base.baseGroupId] ?? []).slice().sort((a, b) => a - b), base.endCodePoint];
    const span = base.frameRange.endFrame - base.frameRange.startFrame;
    return cuts.slice(0, -1).map((startCodePoint, index) => {
      const key = windowKey(base.baseGroupId, startCodePoint);
      const stored = draft.windows[key];
      const startFrame = stored?.startFrame
        ?? base.frameRange.startFrame + Math.round(span * index / (cuts.length - 1));
      const endFrame = stored?.endFrame
        ?? (index + 2 === cuts.length ? base.frameRange.endFrame
          : base.frameRange.startFrame + Math.round(span * (index + 1) / (cuts.length - 1)));
      return {
        sourceRange: { baseGroupId: base.baseGroupId, startCodePoint, endCodePoint: cuts[index + 1]! },
        window: { startFrame, endFrame },
        placement: { anchor: stored?.anchor ?? "start", offsetFrames: stored?.offsetFrames ?? 0 },
      };
    });
  });
}

function materializeCandidate(baseGroups: BaseGroup[], draft: SegmentationDraft) {
  const groups = candidateGroups(baseGroups, draft).map((group) => {
    const key = windowKey(group.sourceRange.baseGroupId, group.sourceRange.startCodePoint);
    const startFrame = secondsToFramesV2(draft.seconds[`${key}:start`] ?? frameSeconds(group.window.startFrame));
    const endFrame = secondsToFramesV2(draft.seconds[`${key}:end`] ?? frameSeconds(group.window.endFrame));
    const offsetFrames = secondsToFramesV2(draft.seconds[`${key}:offset`] ?? frameSeconds(group.placement.offsetFrames));
    if (endFrame <= startFrame || offsetFrames >= endFrame - startFrame) {
      throw new Error("每段的结束时间必须晚于开始时间，且段内留空必须小于可用窗口。");
    }
    return { ...group, window: { startFrame, endFrame }, placement: { ...group.placement, offsetFrames } };
  });
  const userSilences = draft.userSilences.map((silence, index) => {
    const seconds = draft.silenceSeconds[index];
    const startFrame = secondsToFramesV2(seconds?.start ?? frameSeconds(silence.startFrame));
    const endFrame = secondsToFramesV2(seconds?.end ?? frameSeconds(silence.endFrame));
    if (endFrame <= startFrame) throw new Error("留白结束时间必须晚于开始时间。");
    return { startFrame, endFrame };
  });
  return { groups, userSilences };
}

function draftSignature(baseGroups: BaseGroup[], draft: SegmentationDraft): string {
  return JSON.stringify({
    boundaries: draft.boundaries,
    windows: draft.windows,
    seconds: draft.seconds,
    userSilences: draft.userSilences,
    silenceSeconds: draft.silenceSeconds,
    candidate: candidateGroups(baseGroups, draft),
  });
}

function NarrationSegmentationSection({ runId, runRevision, preview: loadedPreview, disabled, onSaved, onUseDefault,
  sequence, ignoreStoredDraft, onDraftPersisted, onReloadGuard }: {
  runId: string;
  runRevision: number;
  preview: StudioNarrationPlanPreview;
  disabled: boolean;
  onSaved(run: StudioRunDetail, plan: StudioNarrationPlanPreview["plan"]): void;
  onUseDefault(): Promise<boolean>;
  sequence: { current: number };
  ignoreStoredDraft: boolean;
  onDraftPersisted(): void;
  onReloadGuard(guard: SegmentationReloadGuard): void;
}) {
  const sourceContextId = loadedPreview.sourceContextId ?? "";
  const baseGroups = editorBaseGroups(loadedPreview);
  const characterPlan = loadedPreview.plan.version === "video-factory/narration-plan-v3" ? loadedPreview.plan : undefined;
  const editorSessionId = useRef(characterPlan ? "character-editor-" + crypto.randomUUID() : `editor-${runId}`).current;
  const loaded = useRef(ignoreStoredDraft ? { draft: initialSegmentationDraft(loadedPreview) }
    : readSegmentationDraft(runId, loadedPreview)).current;
  const [draft, setDraft] = useState(loaded.draft);
  const baseline = useRef(draftSignature(baseGroups, initialSegmentationDraft(loadedPreview)));
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState<StudioNarrationPreviewTicketV2>();
  const [ticketGeneration, setTicketGeneration] = useState<number>();
  const [acknowledge, setAcknowledge] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [storageWarning, setStorageWarning] = useState<string | undefined>(loaded.warning);
  const [busyToken, setBusyToken] = useState<string>();
  const activeRequest = useRef<string | undefined>(undefined);
  const discardingDraft = useRef(false);
  const identity = useRef({ runId, runRevision, sourceContextId, generation: draft.generation });
  identity.current = { runId, runRevision, sourceContextId, generation: draft.generation };
  const currentDraftSignature = draftSignature(baseGroups, draft);
  const dirty = currentDraftSignature !== baseline.current;
  const stale = loadedPreview.expectedRunRevision !== runRevision;

  useEffect(() => {
    onReloadGuard({ dirty, pending: Boolean(busyToken), saving: busyToken?.startsWith("save:") ?? false,
      discard: () => {
        // 明确放弃先隔离旧核价，读取失败时也不能让迟到响应复活旧票据或草稿。
        discardingDraft.current = true;
        activeRequest.current = undefined;
        setBusyToken(undefined);
        setTicket(undefined);
        setTicketGeneration(undefined);
        setAcknowledge(false);
      } });
  }, [dirty, busyToken, onReloadGuard]);

  useEffect(() => () => { activeRequest.current = undefined; }, []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (discardingDraft.current) return;
    try {
      if (dirty) {
        draftStorage(loadedPreview).setItem(segmentationStorageKey(runId), JSON.stringify(draft));
        onDraftPersisted();
      } else draftStorage(loadedPreview).removeItem(segmentationStorageKey(runId));
    } catch {
      if (dirty) setStorageWarning("本机草稿保存失败；当前页面仍保留输入，刷新前请复制留存。");
    }
  }, [draft, dirty, runId]);

  const edit = (change: (current: SegmentationDraft) => SegmentationDraft) => {
    discardingDraft.current = false;
    setDraft((current) => ({ ...change(current), generation: current.generation + 1 }));
    setTicket(undefined);
    setTicketGeneration(undefined);
    setAcknowledge(false);
    setStatus(undefined);
    setError(undefined);
  };

  const runPreview = async () => {
    if (busyToken || disabled || stale || (!dirty && !characterPlan)) return;
    let candidate: ReturnType<typeof materializeCandidate>;
    try {
      candidate = materializeCandidate(baseGroups, draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "时间输入无效，请检查后再核价。");
      return;
    }
    const editSequence = ++sequence.current;
    const token = `${runId}:${runRevision}:${sourceContextId}:${draft.generation}:${editSequence}`;
    activeRequest.current = token;
    setBusyToken(token);
    setError(undefined);
    try {
      const response = await studioApi.narrationPlanPreviewV2(runId, {
        expectedRunRevision: runRevision,
        sourceContextId,
        editorSessionId,
        editSequence,
        ...(characterPlan ? { version: "video-factory/narration-plan-v3" as const } : {}),
        candidate: characterPlan
          ? { version: characterPlan.version, groups: candidate.groups.map((group) => ({
              turnId: group.sourceRange.baseGroupId, window: group.window, placement: group.placement,
            })), userSilences: candidate.userSilences }
          : { version: "video-factory/narration-plan-v2", ...candidate },
      });
      const current = identity.current;
      if (activeRequest.current !== token || current.runId !== runId || current.runRevision !== runRevision
        || current.sourceContextId !== sourceContextId || current.generation !== draft.generation) return;
      setTicket(response);
      setTicketGeneration(draft.generation);
      setAcknowledge(false);
    } catch (caught) {
      if (activeRequest.current === token && identity.current.generation === draft.generation) {
        setError(caught instanceof Error ? caught.message : "候选核价失败；默认连续方案不受影响。");
      }
    } finally {
      if (activeRequest.current === token) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  };

  const save = async () => {
    if (!ticket || ticketGeneration !== draft.generation || busyToken || disabled || stale) return;
    if (ticket.quote.status === "unavailable" && !acknowledge) {
      setError("当前核价不可用：请勾选知情确认后再保存，或稍后重新核价。");
      return;
    }
    const token = `save:${runId}:${ticket.ticketId}:${draft.generation}`;
    activeRequest.current = token;
    setBusyToken(token);
    setError(undefined);
    try {
      const result = await studioApi.confirmNarrationPlanV2(runId, {
        ...(characterPlan ? { version: "video-factory/narration-plan-v3" as const } : {}),
        requestId: `save-${ticket.ticketId}`,
        expectedRunRevision: ticket.expectedRunRevision,
        sourceContextId,
        editorSessionId: ticket.editorSessionId,
        editSequence: ticket.editSequence,
        candidateId: ticket.candidateId,
        ticketId: ticket.ticketId,
        planSha256: ticket.planSha256,
        ...(ticket.quote.status === "unavailable" && acknowledge ? { acknowledgeQuoteUnavailable: true } : {}),
      });
      if (activeRequest.current !== token || identity.current.generation !== draft.generation) return;
      if (result.receipt.accepted) {
        baseline.current = currentDraftSignature;
        setStatus(characterPlan ? "已保存角色配音计划；尚未开始配音，确认当前素材步骤后才进入配音。" : "已保存旁白计划；尚未开始配音，确认当前素材步骤后才进入配音。");
        setTicket(undefined);
        try {
          draftStorage(loadedPreview).removeItem(segmentationStorageKey(runId));
        } catch {
          setStorageWarning("服务端已保存；本机旧草稿未能清理，下次会先按服务端版本核对。");
        }
        onSaved(result.run, ticket.plan);
      }
    } catch (caught) {
      if (activeRequest.current === token) setError(caught instanceof Error ? caught.message : "保存没有完成；草稿保留，请重试。");
    } finally {
      if (activeRequest.current === token) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  };

  const useDefault = async () => {
    if (busyToken || disabled || stale) return;
    const accepted = await onUseDefault();
    if (!accepted) return;
    try {
      window.localStorage.removeItem(segmentationStorageKey(runId));
    } catch {
      setStorageWarning("服务端已保存默认连续方案；本机旧草稿未能清理，下次会先按服务端版本核对。");
    }
  };

  const groups = candidateGroups(baseGroups, draft);
  return <details className="narration-segmentation" aria-label={characterPlan ? "台词与留白" : "分段与留白"} open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{characterPlan ? "台词与留白" : "分段与留白（高级，默认不分段）"}<small>{characterPlan ? "逐句核对角色、时间与费用" : "选择句界、窗口和明确留白"}</small></summary>
    {open ? <>
      <p>{characterPlan ? "每句台词独立配音，不跨角色合并。角色、正文和音色来自当前剧本；如需修改，请返回脚本工作区。这里只调整时间与留白，保存不会生成或付费。" : "正文只读；分段点只使用当前来源认可的句界。任何文字输入变化都会立即使旧核价失效；所有时间合法并按 30fps 量化后才能保存。"}</p>
      {loadedPreview.editorContext.savedPlanStatus === "stale" ? <p role="status">{characterPlan ? "上游角色或台词已更新。旧计划仅供参考，请核对当前台词并重新保存。" : "上游内容已更新。旧分段仅作参考，不能覆盖当前来源；请按当前文字重新选择，或保存默认连续方案。"}</p> : null}
      {baseGroups.map((base, baseIndex) => {
        const selected = draft.boundaries[base.baseGroupId] ?? [];
        const baseSlices = groups.filter((group) => group.sourceRange.baseGroupId === base.baseGroupId);
        const character = characterPlan && loadedPreview.editorContext.characters?.find((c) => c.id === characterPlan.groups[baseIndex]?.speakerId);
        return <fieldset key={base.baseGroupId} disabled={disabled || stale}>
          <legend>{characterPlan ? `台词 ${baseIndex + 1} · ${character?.name ?? "角色"} · 音色：${character?.voiceLabel ?? "剧本中选定的系统音色"}` : `连续段「${Array.from(base.text).slice(0, 18).join("")}${Array.from(base.text).length > 18 ? "…" : ""}」`}</legend>
          <p className="narration-segmentation-text">{base.text}</p>
          {base.allowedBoundaries.length ? <div className="narration-boundary-options" role="group" aria-label="选择分段点">
            {base.allowedBoundaries.map((boundary) => <label key={boundary} className="narration-boundary-option">
              <input type="checkbox" checked={selected.includes(boundary)} onChange={(event) => edit((current) => ({
                ...current,
                boundaries: { ...current.boundaries, [base.baseGroupId]: event.target.checked
                  ? [...(current.boundaries[base.baseGroupId] ?? []), boundary]
                  : (current.boundaries[base.baseGroupId] ?? []).filter((value) => value !== boundary) },
              }))} />
              在「{Array.from(base.text).slice(Math.max(0, boundary - 6), boundary).join("")}」后分段
            </label>)}
          </div> : characterPlan ? null : <p>这段没有可用句界，保持整段。</p>}
          {baseSlices.map((group, index) => {
            const key = windowKey(base.baseGroupId, group.sourceRange.startCodePoint);
            const label = characterPlan ? `第 ${baseIndex + 1} 句` : `第 ${index + 1} 段`;
            const updateRaw = (part: "start" | "end" | "offset", value: string) => edit((current) => ({
              ...current, seconds: { ...current.seconds, [`${key}:${part}`]: value },
            }));
            const quantize = (part: "start" | "end" | "offset") => {
              const raw = draft.seconds[`${key}:${part}`] ?? "";
              try {
                const frames = secondsToFramesV2(raw);
                edit((current) => ({
                  ...current,
                  windows: { ...current.windows, [key]: {
                    ...(current.windows[key] ?? { ...group.window, ...group.placement }),
                    ...(part === "start" ? { startFrame: frames } : part === "end" ? { endFrame: frames } : { offsetFrames: frames }),
                  } },
                  seconds: { ...current.seconds, [`${key}:${part}`]: frameSeconds(frames) },
                }));
              } catch {
                setError("时间请输入非负十进制秒（至多 6 位小数）；非法输入不会退回旧帧提交。");
              }
            };
            return <div key={key} className="narration-window-inputs">
              <strong>{label}「{Array.from(base.text).slice(group.sourceRange.startCodePoint, group.sourceRange.startCodePoint + 10).join("")}…」</strong>
              <label className="field"><span>窗口开始（秒）</span><input type="text" inputMode="decimal" aria-label={`${label}窗口开始秒`}
                value={draft.seconds[`${key}:start`] ?? frameSeconds(group.window.startFrame)}
                onChange={(event) => updateRaw("start", event.target.value)} onBlur={() => quantize("start")} /></label>
              <label className="field"><span>窗口结束（秒）</span><input type="text" inputMode="decimal" aria-label={`${label}窗口结束秒`}
                value={draft.seconds[`${key}:end`] ?? frameSeconds(group.window.endFrame)}
                onChange={(event) => updateRaw("end", event.target.value)} onBlur={() => quantize("end")} /></label>
              <label className="field"><span>声音落点</span><select aria-label={`${label}落点`} value={group.placement.anchor}
                onChange={(event) => edit((current) => ({ ...current, windows: { ...current.windows, [key]: {
                  ...(current.windows[key] ?? { ...group.window, ...group.placement }),
                  anchor: event.target.value === "end" ? "end" : "start",
                } } }))}>
                <option value="start">从窗口开头说起</option><option value="end">贴近窗口结尾说完</option>
              </select></label>
              <label className="field"><span>段内留空（秒）</span><input type="text" inputMode="decimal" aria-label={`${label}留空秒`}
                value={draft.seconds[`${key}:offset`] ?? frameSeconds(group.placement.offsetFrames)}
                onChange={(event) => updateRaw("offset", event.target.value)} onBlur={() => quantize("offset")} /></label>
              <small>当前窗口 {group.window.startFrame}–{group.window.endFrame} 帧</small>
            </div>;
          })}
        </fieldset>;
      })}
      <fieldset disabled={disabled || stale}>
        <legend>显式留白</legend>
        {draft.userSilences.map((silence, index) => <div key={index} className="narration-silence-inputs">
          <label className="field"><span>留白 {index + 1} 开始（秒）</span><input type="text" inputMode="decimal" aria-label={`留白 ${index + 1} 开始秒`}
            value={draft.silenceSeconds[index]?.start ?? frameSeconds(silence.startFrame)} onChange={(event) => edit((current) => ({
              ...current,
              silenceSeconds: current.silenceSeconds.map((item, position) => position === index ? { ...item, start: event.target.value } : item),
            }))} onBlur={() => {
              try {
                const value = secondsToFramesV2(draft.silenceSeconds[index]?.start ?? "");
                edit((current) => ({ ...current,
                  userSilences: current.userSilences.map((item, position) => position === index ? { ...item, startFrame: value } : item),
                  silenceSeconds: current.silenceSeconds.map((item, position) => position === index ? { ...item, start: frameSeconds(value) } : item),
                }));
              } catch { setError("留白时间请输入非负十进制秒；非法输入不会退回旧帧提交。"); }
            }} /></label>
          <label className="field"><span>留白 {index + 1} 结束（秒）</span><input type="text" inputMode="decimal" aria-label={`留白 ${index + 1} 结束秒`}
            value={draft.silenceSeconds[index]?.end ?? frameSeconds(silence.endFrame)} onChange={(event) => edit((current) => ({
              ...current,
              silenceSeconds: current.silenceSeconds.map((item, position) => position === index ? { ...item, end: event.target.value } : item),
            }))} onBlur={() => {
              try {
                const value = secondsToFramesV2(draft.silenceSeconds[index]?.end ?? "");
                edit((current) => ({ ...current,
                  userSilences: current.userSilences.map((item, position) => position === index ? { ...item, endFrame: value } : item),
                  silenceSeconds: current.silenceSeconds.map((item, position) => position === index ? { ...item, end: frameSeconds(value) } : item),
                }));
              } catch { setError("留白时间请输入非负十进制秒；非法输入不会退回旧帧提交。"); }
            }} /></label>
          <button type="button" className="button button-secondary" onClick={() => edit((current) => ({
            ...current,
            userSilences: current.userSilences.filter((_, position) => position !== index),
            silenceSeconds: current.silenceSeconds.filter((_, position) => position !== index),
          }))}>移除留白</button>
        </div>)}
        <button type="button" className="button button-secondary" onClick={() => edit((current) => ({
          ...current,
          userSilences: [...current.userSilences, { startFrame: 0, endFrame: 1 }],
          silenceSeconds: [...current.silenceSeconds, { start: "0", end: frameSeconds(1) }],
        }))}>添加留白</button>
      </fieldset>
      {error ? <p className="error-message" role="alert">{error}</p> : null}
      {storageWarning ? <p role="status">{storageWarning}</p> : null}
      {status ? <p role="status">{status}</p> : null}
      {stale ? <p role="status">制作记录已更新，旧草稿只读；请重新查看当前方案。</p> : null}
      <button type="button" className="button button-secondary" disabled={Boolean(busyToken) || disabled || stale || (!dirty && !characterPlan)} onClick={() => void runPreview()}>{characterPlan ? "预览台词并核价" : "预览分段并核价"}</button>
      {ticket && ticketGeneration === draft.generation ? <div className="narration-candidate-quote">
        <p>本次分段 {ticket.plan.groups.length} 段。{ticket.quote.status === "estimated"
          ? `新合成 ${ticket.quote.items?.filter((item) => !item.reused).length ?? 0} 组，保守预估 ¥${(ticket.quote.maxCostCny ?? 0).toFixed(2)}（配置价，不是账单）。`
          : "当前核价不可得：价格未知（不是 0），实际执行仍受限额约束。"}</p>
        {ticket.quote.status === "unavailable" ? <label className="field"><input type="checkbox" checked={acknowledge}
          onChange={(event) => setAcknowledge(event.target.checked)} />知情确认按未知价格保存</label> : null}
        <button type="button" className="button button-primary" disabled={Boolean(busyToken) || disabled || stale} onClick={() => void save()}>{characterPlan ? "保存角色配音计划" : "保存旁白计划"}</button>
      </div> : null}
      {!characterPlan ? <button type="button" className="button button-ghost" disabled={Boolean(busyToken) || disabled || stale}
        onClick={() => void useDefault()}>取消高级分段，保存默认连续方案</button> : null}
    </> : null}
  </details>;
}

export function NarrationPlanEditor({ runId, runRevision, disabled, characterDrama = false, onEditCharacters, onRunUpdated }: { runId: string; runRevision: number; disabled: boolean; characterDrama?: boolean; onEditCharacters?: () => void; onRunUpdated?: (run: StudioRunDetail) => void }) {
  const [preview, setPreview] = useState<StudioNarrationPlanPreview>();
  const [busyToken, setBusyToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [loadedRunId, setLoadedRunId] = useState<string>();
  const identity = useRef({ runId, runRevision });
  identity.current = { runId, runRevision };
  const requestSerial = useRef(0);
  const activeRequest = useRef<string | undefined>(undefined);
  const loadedPlanSignature = useRef<string | undefined>(undefined);
  const segmentationGuard = useRef<SegmentationReloadGuard | undefined>(undefined);
  const ignoredDraftRun = useRef<string | undefined>(undefined);
  const [storageWarning, setStorageWarning] = useState<string>();
  const [loadGeneration, setLoadGeneration] = useState(0);
  // 同源重读重建编辑快照，但不能倒退已经预留的核价序号。
  const previewSequence = useRef(0);
  const [reloadPrompt, setReloadPrompt] = useState(false);
  const reloadDialogRef = useDialogFocus<HTMLElement>(reloadPrompt, () => setReloadPrompt(false), Boolean(busyToken));
  const stale = Boolean(preview && (loadedRunId !== runId || preview.expectedRunRevision !== runRevision));
  const planV1 = preview?.plan.version === "video-factory/narration-plan-v1" ? preview.plan : undefined;
  const characterMode = characterDrama || preview?.plan.version === "video-factory/narration-plan-v3";
  const v1Dirty = Boolean(planV1 && loadedPlanSignature.current !== undefined
    && JSON.stringify(planV1) !== loadedPlanSignature.current);

  function requestLoad() {
    if (busyToken || activeRequest.current || disabled) return;
    if (segmentationGuard.current?.saving) {
      setError("旁白方案正在保存；请等原请求完成后再重新查看，不要重复保存。");
      return;
    }
    if (v1Dirty || segmentationGuard.current?.dirty || segmentationGuard.current?.pending) setReloadPrompt(true);
    else void load();
  }

  function discardAndLoad() {
    if (busyToken || activeRequest.current || segmentationGuard.current?.saving) return;
    segmentationGuard.current?.discard();
    const draftRunId = loadedRunId ?? runId;
    ignoredDraftRun.current = draftRunId;
    try {
      window.localStorage.removeItem(segmentationStorageKey(draftRunId));
      window.sessionStorage.removeItem(segmentationStorageKey(draftRunId));
      setStorageWarning(undefined);
    } catch {
      setStorageWarning("本机旧草稿未能清理；本页不再恢复已放弃的副本，刷新前请确认本机存储可用。");
    }
    setReloadPrompt(false);
    void load();
  }

  async function load() {
    const token = `load:${runId}:${runRevision}:${++requestSerial.current}`;
    activeRequest.current = token;
    setBusyToken(token);
    setError(undefined);
    try {
      const result = await studioApi.narrationPlan(runId);
      if (activeRequest.current !== token || identity.current.runId !== runId || identity.current.runRevision !== runRevision) return;
      loadedPlanSignature.current = JSON.stringify(result.plan);
      setPreview(result);
      setLoadedRunId(runId);
      setSaved(result.confirmed);
      setLoadGeneration((value) => value + 1);
      segmentationGuard.current = undefined;
    } catch (caught) {
      if (activeRequest.current === token) setError(caught instanceof Error ? caught.message : "旁白方案读取失败，请稍后再试。");
    } finally {
      if (activeRequest.current === token) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  }

  async function confirmPlan(plan: NonNullable<typeof planV1>): Promise<boolean> {
    if (!preview || stale || busyToken || disabled) return false;
    const token = `confirm:${runId}:${preview.expectedRunRevision}:${++requestSerial.current}`;
    activeRequest.current = token;
    setBusyToken(token);
    setError(undefined);
    try {
      const result = await studioApi.confirmNarrationPlan(runId, { expectedRunRevision: preview.expectedRunRevision, plan });
      if (activeRequest.current !== token || identity.current.runId !== runId) return false;
      loadedPlanSignature.current = JSON.stringify(plan);
      setPreview({ ...preview, expectedRunRevision: result.revision, plan, confirmed: true });
      setSaved(true);
      onRunUpdated?.(result);
      return true;
    } catch (caught) {
      if (activeRequest.current === token) setError(caught instanceof Error ? caught.message : "旁白方案保存失败，当前选择仍保留。");
      return false;
    } finally {
      if (activeRequest.current === token) {
        activeRequest.current = undefined;
        setBusyToken(undefined);
      }
    }
  }

  return <section className="node-preview-section narration-plan-editor" aria-label={characterMode ? "角色配音方案" : "连贯旁白方案"}>
    <h3>{characterMode ? "角色配音方案" : "让旁白连成故事"}</h3>
    {characterMode && onEditCharacters ? <button type="button" className="button button-ghost" disabled={disabled || Boolean(busyToken)} onClick={onEditCharacters}>修改角色、台词或音色</button> : null}
    <p>{characterMode ? "逐句核对角色与音色，调整说话时间。先保存计划，再由你确认制作；不会把对白合并成单人旁白。" : "相邻镜头的旁白连起来说，换镜时不断句；无旁白镜头保留留白。不改原稿、不改变画面总时长。文字里的“停两秒”不会自动变成精确停顿。"}</p>
    <button type="button" className="button button-secondary" disabled={Boolean(busyToken) || disabled} onClick={requestLoad}>
      {characterMode ? preview ? "重新查看角色配音方案" : "查看角色配音方案" : preview ? "重新查看旁白方案" : "查看连贯旁白方案"}
    </button>
    {reloadPrompt ? <div className="dialog-backdrop" role="presentation"><section ref={reloadDialogRef}
      className="decision-dialog" role="alertdialog" aria-modal="true" tabIndex={-1} aria-label="放弃旁白草稿并重新查看">
      <p>当前有未保存的旁白修改或正在核价的候选。重新查看会放弃本页草稿与旧核价；不会采用方案或开始配音。</p>
      <footer className="dialog-actions">
        <button type="button" className="button button-secondary" data-dialog-initial-focus onClick={() => setReloadPrompt(false)}>返回继续编辑</button>
        <button type="button" className="button button-danger" onClick={discardAndLoad}>放弃草稿并重新查看</button>
      </footer>
    </section></div> : null}
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {storageWarning ? <p role="status">{storageWarning}</p> : null}
    {preview ? <>
      {!characterMode && preview.plan.groups.map((group, index) => <fieldset key={group.id} disabled={Boolean(busyToken) || reloadPrompt || disabled || saved || stale || !planV1}>
        <legend>第 {index + 1} 组 · 镜头 {group.sourceScenePositions.join("、")}</legend>
        <p>{group.text}</p>
        <small>画面区间 {(group.window.startFrame / 30).toFixed(1)}–{(group.window.endFrame / 30).toFixed(1)} 秒
          {(group.text.match(/[\p{L}\p{N}]/gu) || []).length ? ` · ${group.text.match(/[\p{L}\p{N}]/gu)!.length} 字` : ""}</small>
        <label className="field"><span>声音落点</span><select aria-label={`第 ${index + 1} 组落点`} value={group.placement.anchor} onChange={(event) => {
          if (!planV1) return;
          const next = structuredClone(preview);
          next.plan.groups[index]!.placement.anchor = event.target.value === "end" ? "end" : "start";
          setPreview(next);
        }}><option value="start">从这一段开头说起</option><option value="end">贴近这一段结尾说完</option></select></label>
        <label className="field"><span>向段内留空（秒）</span><input type="number" min="0" step="0.1"
          max={((group.window.endFrame - group.window.startFrame - 1) / 30).toFixed(2)} aria-label={`第 ${index + 1} 组留空`}
          value={Number((group.placement.offsetFrames / 30).toFixed(3))} onChange={(event) => {
            if (!planV1) return;
            const seconds = Number(event.target.value);
            if (!Number.isFinite(seconds) || seconds < 0) return;
            const next = structuredClone(preview);
            next.plan.groups[index]!.placement.offsetFrames = Math.round(seconds * 30);
            setPreview(next);
          }} /></label>
      </fieldset>)}
      {preview.plan.silences.length ? <p>明确留白：{preview.plan.silences.map((silence) =>
        `${(silence.startFrame / 30).toFixed(1)}–${(silence.endFrame / 30).toFixed(1)} 秒`).join("；")}，不会放入旁白。</p> : null}
      <p>{characterMode ? "实际声音长度在配音后才能确定。台词过长时保留原音频等你调整，不截词、不加速。" : "实际声音长度在配音后才能确定。中文旁白常见语速约每秒 3–5 字；过长时保留原音频等你调整，不截词、不加速。"}</p>
      <p>保存{characterMode ? "角色配音" : "旁白"}方案本身不收费，也不开始配音；确认当前素材步骤后才会进入配音。</p>
      {preview.editorContext.mode === "pre_generation" && preview.sourceContextId
        ? <NarrationSegmentationSection key={`${loadedRunId}:${preview.sourceContextId}:${loadGeneration}`}
            runId={loadedRunId ?? runId} runRevision={runRevision} preview={preview}
            disabled={Boolean(busyToken) || reloadPrompt || disabled || loadedRunId !== runId}
            sequence={previewSequence} ignoreStoredDraft={ignoredDraftRun.current === loadedRunId}
            onReloadGuard={(guard) => { segmentationGuard.current = guard; }}
            onDraftPersisted={() => {
              if (ignoredDraftRun.current === loadedRunId) {
                ignoredDraftRun.current = undefined;
                setStorageWarning(undefined);
              }
            }}
            onSaved={(nextRun, savedPlan) => {
              setPreview({ ...preview, expectedRunRevision: nextRun.revision, plan: savedPlan, confirmed: true });
              setSaved(true);
              onRunUpdated?.(nextRun);
            }} onUseDefault={() => preview.editorContext.defaultPlan.version === "video-factory/narration-plan-v1" ? confirmPlan(preview.editorContext.defaultPlan) : Promise.resolve(false)} />
        : null}
      {preview.quote ? <section aria-label="旁白费用预估"><p>本次需新合成 {preview.quote.items.filter((item) => !item.reused).length} 组，
        可复用 {preview.quote.items.filter((item) => item.reused).length} 组；保守预估 ¥{preview.quote.maxCostCny.toFixed(2)}。</p>
        <p>按每万计费字符 ¥{preview.quote.unitPriceCny} 估算；这是配置价，不是已核对账单。</p></section>
        : <p>当前服务没有提供逐组预估，尚不能确认本次费用；实际执行仍受限额约束。</p>}
      {saved && !stale ? <><p role="status">{characterMode ? "已保存角色配音方案；尚未开始配音，请继续确认当前素材步骤。" : "已采用旁白方案；尚未开始配音，请继续确认当前素材步骤。"}</p>
        {planV1 ? <button type="button" className="button button-secondary" disabled={Boolean(busyToken) || disabled} onClick={() => setSaved(false)}>调整这份方案</button> : null}</> : <>
        {stale ? <p role="status">制作记录已更新，请重新查看方案。</p> : null}
        {planV1 ? <button type="button" className="button button-primary" disabled={Boolean(busyToken) || disabled || stale} onClick={() => void confirmPlan(planV1)}>采用这份旁白方案</button>
          : <p role="status">{characterMode ? "请在“台词与留白”中核对并保存角色配音计划。" : "当前是已保存的分段旁白计划；可在上方“分段与留白”中重新打开编辑，或显式回到默认连续方案。"}</p>}
      </>}
    </> : null}
  </section>;
}
