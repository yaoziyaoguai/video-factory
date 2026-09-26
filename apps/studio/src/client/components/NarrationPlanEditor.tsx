import { useRef, useState } from "react";
import type { StudioNarrationPlanPreview } from "../../shared/api.js";
import { studioApi } from "../api.js";

export function NarrationPlanEditor({ runId, runRevision, disabled }: { runId: string; runRevision: number; disabled: boolean }) {
  const [preview, setPreview] = useState<StudioNarrationPlanPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [loadedRunId, setLoadedRunId] = useState<string>();
  const identity = useRef({ runId, runRevision });
  identity.current = { runId, runRevision };
  const stale = Boolean(preview && (loadedRunId !== runId || preview.expectedRunRevision !== runRevision));

  async function load() {
    const source = { runId, runRevision };
    setBusy(true);
    setError(undefined);
    try {
      const result = await studioApi.narrationPlan(runId);
      if (identity.current.runId !== source.runId || identity.current.runRevision !== source.runRevision) return;
      setPreview(result);
      setLoadedRunId(runId);
      setSaved(result.confirmed);
    } catch (caught) {
      if (identity.current.runId === source.runId) setError(caught instanceof Error ? caught.message : "旁白方案读取失败，请稍后再试。");
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (!preview || stale || busy || disabled) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await studioApi.confirmNarrationPlan(runId, { expectedRunRevision: preview.expectedRunRevision, plan: preview.plan });
      if (identity.current.runId === runId && (identity.current.runRevision === preview.expectedRunRevision || identity.current.runRevision === result.revision)) {
        setPreview({ ...preview, expectedRunRevision: result.revision, confirmed: true });
        setSaved(true);
      }
    } catch (caught) {
      if (identity.current.runId === runId) setError(caught instanceof Error ? caught.message : "旁白方案保存失败，请保留当前选择后重试。");
    } finally { setBusy(false); }
  }

  return <section className="node-preview-section narration-plan-editor" aria-label="连贯旁白方案">
    <h3>让旁白连成故事</h3>
    <p>相邻镜头的旁白连起来说，换镜时不断句；保留脚本中明确的留白。不改原稿、不改变画面时长。</p>
    <button type="button" className="button button-secondary" disabled={busy || disabled} onClick={() => void load()}>
      {preview ? "重新查看旁白方案" : "查看连贯旁白方案"}
    </button>
    {error ? <p className="error-message" role="alert">{error}</p> : null}
    {preview ? <>
      {preview.plan.groups.map((group, index) => <fieldset key={group.id} disabled={busy || disabled || saved || stale}>
        <legend>第 {index + 1} 组 · 镜头 {group.sourceScenePositions.join("、")}</legend>
        <p>{group.text}</p>
        <small>画面区间 {(group.window.startFrame / 30).toFixed(1)}–{(group.window.endFrame / 30).toFixed(1)} 秒</small>
        <label className="field"><span>声音落点</span><select aria-label={`第 ${index + 1} 组落点`} value={group.placement.anchor} onChange={(event) => {
          const next = structuredClone(preview);
          next.plan.groups[index]!.placement.anchor = event.target.value === "end" ? "end" : "start";
          setPreview(next);
        }}><option value="start">从这一段开头说起</option><option value="end">贴近这一段结尾说完</option></select></label>
        <label className="field"><span>向段内留空（秒）</span><input type="number" min="0" step="0.1"
          max={((group.window.endFrame - group.window.startFrame - 1) / 30).toFixed(2)}
          aria-label={`第 ${index + 1} 组留空`} value={Number((group.placement.offsetFrames / 30).toFixed(3))}
          onChange={(event) => {
            const seconds = Number(event.target.value);
            if (!Number.isFinite(seconds) || seconds < 0) return;
            const next = structuredClone(preview);
            next.plan.groups[index]!.placement.offsetFrames = Math.round(seconds * 30);
            setPreview(next);
          }} /></label>
      </fieldset>)}
      {preview.plan.silences.length ? <p>明确留白：{preview.plan.silences.map((silence) =>
        `${(silence.startFrame / 30).toFixed(1)}–${(silence.endFrame / 30).toFixed(1)} 秒`).join("；")}，不会放入旁白。</p> : null}
      <p>实际声音长度在配音后才能确定。多余空档会列出，过长时保留原音频等你调整，不截词、不加速。同步字幕取决于本次服务返回，未取得时会明确提醒。</p>
      <p>采用方案本身不收费，也不开始制作。下一步配音按已配置的按量费用与限额执行；旧配音模式不会被自动替换。</p>
      {preview.quote ? <section aria-label="旁白费用预估"><p>本次需新合成 {preview.quote.items.filter((item) => !item.reused).length} 组，
        可复用 {preview.quote.items.filter((item) => item.reused).length} 组；保守预估 ¥{preview.quote.maxCostCny.toFixed(2)}。</p>
        <p>按每万计费字符 ¥{preview.quote.unitPriceCny} 估算，包含输入文字和停顿控制。此为配置价预估，不是已核对账单；不会抹去原音频的历史费用。</p></section>
        : <p>当前服务没有提供逐组预估，尚不能确认本次费用；实际执行仍受已配置限额约束。</p>}
      {saved && !stale ? <><p role="status">已采用旁白方案；尚未开始配音，请继续确认当前素材步骤。</p>
        <button type="button" className="button button-secondary" disabled={busy || disabled} onClick={() => { setSaved(false); }}>调整这份方案</button></> : <>
        {stale ? <p role="status">制作记录已更新，请重新查看方案。</p> : null}
        <button type="button" className="button button-primary" disabled={busy || disabled || stale} onClick={() => void confirm()}>采用这份旁白方案</button>
      </>}
    </> : null}
  </section>;
}
