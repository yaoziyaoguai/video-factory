import { useEffect, useState } from "react";
import { assertDurationCommitment, parseDurationAmendment, type DurationAmendment } from "@video-factory/production-pipeline/executable-timeline";
import type { StudioCreativeReviewSnapshot } from "../../shared/api.js";
import { clearCreativeSessionFields, creativeSessionSlotKey, creativeSessionStorage, readCreativeSessionSlot, writeCreativeSessionFields } from "../creative-draft-session.js";

export function durationSecondsLabel(seconds: number): string {
  return String(Number(seconds.toFixed(3)));
}

interface DurationEditor {
  identity: string;
  briefSha256: string;
  min: string;
  max: string;
  clear: boolean;
}

export function CreativeDurationPanel({ review, busy = false, onSave, onAdopt, onEditingChange }: {
  review: StudioCreativeReviewSnapshot;
  busy?: boolean;
  onSave?: (amendment: DurationAmendment) => Promise<boolean>;
  onAdopt?: (amendment: DurationAmendment) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
}) {
  // 与稿件编辑使用同一标签会话存储；槽位不含版本，刷新或另一标签更新后仍能找回旧输入。
  const purposeKey = `${review.reviewPurpose ?? "draft"}:duration`;
  const storageKey = creativeSessionSlotKey(review.runId, review.stage, purposeKey);
  const [editor, setEditor] = useState<DurationEditor | null>(() => {
    const saved = readCreativeSessionSlot(creativeSessionStorage().storage, storageKey)?.document;
    const value = saved?.document;
    if (!saved || !value || typeof saved.baseKey !== "string" || typeof value.briefSha256 !== "string"
      || typeof value.min !== "string" || typeof value.max !== "string" || typeof value.clear !== "boolean") return null;
    return { identity: saved.baseKey, briefSha256: value.briefSha256, min: value.min, max: value.max, clear: value.clear };
  });
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [storageBroken, setStorageBroken] = useState(false);
  useEffect(() => {
    const { storage, durable } = creativeSessionStorage();
    const saved = editor ? writeCreativeSessionFields(storage, storageKey, { runId: review.runId, stage: review.stage, purposeKey }, {
      document: { baseKey: editor.identity, document: { briefSha256: editor.briefSha256, min: editor.min, max: editor.max, clear: editor.clear } },
    }) : clearCreativeSessionFields(storage, storageKey, ["document"]);
    if (!saved || !durable) setStorageBroken(true);
  }, [editor, storageKey, review.runId, review.stage, purposeKey]);
  useEffect(() => { onEditingChange?.(editor !== null); }, [editor !== null, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const duration = review.duration;
  if (!duration) return null;
  const identity = JSON.stringify([review.runId, review.stage, review.reviewPurpose, review.runRevision,
    review.reviewRevision, review.draftVersionId, review.draftSha256, duration.briefSha256]);
  const stale = editor !== null && editor.identity !== identity;
  const disabled = busy || saving || stale || !review.allowedActions.includes("update_duration");
  function openEditor() {
    setError(undefined);
    setEditor({ identity, briefSha256: duration!.briefSha256, clear: false,
      min: duration!.commitment?.minSeconds?.toString() ?? "", max: duration!.commitment?.maxSeconds?.toString() ?? "" });
  }
  const capabilityConflict = review.conflicts?.some(conflict => conflict.code === "execution_capability_conflict") === true;
  const adoptionDisabled = disabled || capabilityConflict || !review.allowedActions.includes("confirm") || Boolean(review.draftValidation?.issues.length);
  async function save(adopt = false) {
    if (!editor || disabled || !onSave || (adopt && (adoptionDisabled || !onAdopt))) return;
    setError(undefined);
    setSaving(true);
    try {
      const amendment = parseDurationAmendment({ expectedBriefSha256: editor.briefSha256,
        range: editor.clear ? null : {
          ...(editor.min.trim() ? { minSeconds: Number(editor.min) } : {}),
          ...(editor.max.trim() ? { maxSeconds: Number(editor.max) } : {}),
        } });
      if (adopt && duration!.proposal) assertDurationCommitment(duration!.proposal.totalFrames, amendment.range ?? undefined);
      if (await (adopt ? onAdopt!(amendment) : onSave(amendment))) setEditor(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSaving(false); }
  }
  const proposal = duration.proposal;
  const adopted = duration.previouslyAdopted;
  const changed = proposal && adopted && proposal.totalFrames !== adopted.totalFrames;
  return <section className="creative-check-result creative-duration-panel" aria-label="本版时长">
    {proposal ? <>
      <strong>建议成片约 {durationSecondsLabel(proposal.totalSeconds)} 秒，共 {proposal.scenes.length} 镜</strong>
      <p>以当前脚本的 {proposal.totalFrames} 帧计算；采用这版脚本时一并确认，不会自动设成硬性范围。</p>
      <ul>{proposal.scenes.map(scene => <li key={scene.position}>第 {scene.position} 镜：{durationSecondsLabel(scene.durationSeconds)} 秒（{scene.frameCount} 帧）</li>)}</ul>
    </> : <p>{duration.unavailableReason ?? "目标仅作参考，脚本会给出具体总长供你确认。"}</p>}
    <p>参考目标：{durationSecondsLabel(duration.referenceSeconds)} 秒，不代表已确认的成片时长。</p>
    <p>{duration.policy === "legacy" ? "沿用旧版时长约束" : "你明确设置的时长要求"}：{duration.commitment
      ? [duration.commitment.minSeconds === undefined ? null : `至少 ${durationSecondsLabel(duration.commitment.minSeconds)} 秒`,
        duration.commitment.maxSeconds === undefined ? null : `最多 ${durationSecondsLabel(duration.commitment.maxSeconds)} 秒`].filter(Boolean).join("，")
      : "未设硬性范围"}</p>
    {changed ? <p role="status">时长变化：原 {durationSecondsLabel(adopted.totalSeconds)} 秒 → 建议 {durationSecondsLabel(proposal.totalSeconds)} 秒。当前镜头安排已改变，素材覆盖、声音安排及报价需要按新版本核对；旧版采用不代表已采用这版。</p> : null}
    <p>费用待方案核价；这里的时长不是购买授权。</p>
    {review.conflicts?.length ? <div role="status"><strong>当前稿需要调整后才能采用</strong>
      <ul>{review.conflicts.map((conflict, index) => <li key={`${conflict.code}:${index}`}>{conflict.scenePositions.length ? `镜头 ${conflict.scenePositions.join("、")}：` : ""}{conflict.detail}</li>)}</ul>
      <p>{review.conflicts.some(conflict => conflict.code === "execution_capability_conflict")
        ? "请修改分镜或素材安排；取消时长要求不能补足实际媒体或型号能力。"
        : "可修改脚本，或修改、取消下方的时长要求；当前内容会保留。"}</p>
    </div> : null}
    {duration.policy === "content-led-v1" && onSave ? editor ? <div className="creative-duration-editor">
      <strong>修改时长要求</strong>
      {storageBroken ? <p role="alert">本机草稿存储暂不可用；当前输入仍在页面中，但刷新后可能无法恢复，请先复制保存。</p> : null}
      <p>只记录你明确填写的边界，不补另一端；保存不会采用稿件、生成或购买素材。</p>
      <label className="field">至少秒数（可不填）<input aria-label="至少秒数（可不填）" inputMode="decimal" value={editor.min} disabled={busy || saving || editor.clear}
        onChange={event => setEditor({ ...editor, min: event.target.value })} /></label>
      <label className="field">最多秒数（可不填）<input aria-label="最多秒数（可不填）" inputMode="decimal" value={editor.max} disabled={busy || saving || editor.clear}
        onChange={event => setEditor({ ...editor, max: event.target.value })} /></label>
      <label><input type="checkbox" checked={editor.clear} disabled={busy || saving}
        onChange={event => setEditor({ ...editor, clear: event.target.checked })} />取消明确时长要求（不限制总长，实际媒体能力仍需满足）</label>
      <p>变更时长要求后，这版稿件未重新审计；采用将保留此前意见，并明确接受新版本未审计。仅保存不会推进。</p>
      {stale ? <p role="alert">稿件或时长要求已变化，输入已保留但不能覆盖新版本。请先查看当前稿，再放弃此处输入重新填写。</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="creative-decision-buttons">
        <button type="button" className="button button-secondary" disabled={disabled} onClick={() => void save()}>仅保存时长要求</button>
        {onAdopt ? <button type="button" className="button button-primary" disabled={adoptionDisabled} onClick={() => void save(true)}>按新时长要求采用当前{review.stage === "script" ? "脚本" : review.stage === "director" ? "导演方案" : "构思"}（未审计）</button> : null}
        <button type="button" className="button button-ghost" disabled={busy || saving} onClick={() => { setEditor(null); setError(undefined); }}>放弃时长修改</button>
      </div>
    </div> : <button type="button" className="button button-secondary" disabled={busy || !review.allowedActions.includes("update_duration")} onClick={openEditor}>修改时长要求</button> : null}
  </section>;
}
