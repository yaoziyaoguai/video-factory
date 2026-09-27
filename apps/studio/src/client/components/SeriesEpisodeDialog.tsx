import { AlertCircle, Check, PencilLine, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  parseStudioSeriesEpisodePlanInput,
  type StudioSeries,
  type StudioSeriesEpisode,
  type StudioSeriesEpisodePlanInput,
} from "../../shared/api.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

interface SeriesEpisodeDialogProps {
  open: boolean;
  series: StudioSeries;
  episode: StudioSeriesEpisode;
  onClose: () => void;
  onSubmit: (input: StudioSeriesEpisodePlanInput) => Promise<void>;
}

export function SeriesEpisodeDialog(props: SeriesEpisodeDialogProps) {
  return props.open ? <SeriesEpisodeDraft key={`${props.series.id}:${props.episode.id}`} {...props} /> : null;
}

function SeriesEpisodeDraft({ open, series: latestSeries, episode: latestEpisode, onClose, onSubmit }: SeriesEpisodeDialogProps) {
  // 打开时冻结编辑来源；刷新不能替换草稿或借用新版revision提交旧内容。
  const [{ series, episode }] = useState(() => ({ series: latestSeries, episode: latestEpisode }));
  const sourceChanged = latestSeries.revision !== series.revision;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const baseline = useRef("");
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  useEffect(() => {
    baseline.current = formRef.current ? JSON.stringify([...new FormData(formRef.current)]) : "";
  }, []);
  function requestClose() {
    if (submitting) return;
    if (discardPromptOpen) { setDiscardPromptOpen(false); return; }
    const current = formRef.current ? JSON.stringify([...new FormData(formRef.current)]) : "";
    if (current !== baseline.current) setDiscardPromptOpen(true);
    else onClose();
  }
  const dialogRef = useDialogFocus<HTMLElement>(open, requestClose, submitting, discardPromptOpen);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || sourceChanged) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      await onSubmit(parseStudioSeriesEpisodePlanInput({
        expectedRevision: series.revision,
        pillar: required(data, "pillar"),
        title: required(data, "title"),
        viewerPromise: required(data, "viewerPromise"),
        hook: required(data, "hook"),
        payoff: required(data, "payoff"),
        fromPrevious: lines(data, "fromPrevious"),
        toNext: lines(data, "toNext"),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section ref={dialogRef} className="run-dialog series-episode-dialog" role="dialog" aria-modal="true" aria-labelledby="series-episode-dialog-title" tabIndex={-1}>
        <header className="dialog-header" inert={discardPromptOpen}>
          <div><p className="eyebrow">路线图人工修订</p><h2 id="series-episode-dialog-title">编辑第 {episode.episodeNumber} 集</h2><p>保存只形成新的人工版本，不会自动审计或进入制作。你可以再审，也可以直接采用；后续角色会读取你采用的版本。</p></div>
          <button className="icon-button" type="button" onClick={requestClose} disabled={submitting} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <form ref={formRef} inert={discardPromptOpen} className="run-form series-episode-form" onSubmit={submit}>
          <label className="field"><span>内容支柱</span>{series.pillars.length
            ? <select name="pillar" defaultValue={episode.pillar}>{series.pillars.map((pillar) => <option key={pillar} value={pillar}>{pillar}</option>)}</select>
            : <input name="pillar" defaultValue={episode.pillar} required />}</label>
          <label className="field field-wide"><span>单集标题</span><input name="title" defaultValue={episode.title} required data-dialog-initial-focus /></label>
          <label className="field field-wide"><span>这一集给观众什么</span><textarea name="viewerPromise" defaultValue={episode.viewerPromise} rows={2} required /></label>
          <label className="field field-wide"><span>开场钩子</span><textarea name="hook" defaultValue={episode.hook} rows={2} required /></label>
          <label className="field field-wide"><span>本集必须兑现</span><textarea name="payoff" defaultValue={episode.payoff} rows={2} required /></label>
          <label className="field"><span>本集额外承接要求</span><textarea name="fromPrevious" defaultValue={episode.continuity.fromPrevious.join("\n")} rows={3} placeholder="每行一项；系统继承的正史交接会单独保留" /></label>
          <label className="field"><span>留给下一集</span><textarea name="toNext" defaultValue={episode.continuity.toNext.join("\n")} rows={3} placeholder="每行一项" /></label>
          <p className="series-edit-notice field-wide"><PencilLine aria-hidden="true" size={16} /><span><strong>人工版本优先</strong> 系统不会把 AI 路线图的旧结果悄悄覆盖回来。保存后，原策划审计会标为已失效。</span></p>
          {error ? <p className="form-error field-wide" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          {sourceChanged ? <p className="form-error field-wide" role="alert">路线图已更新，这份草稿已保留供你复制；请关闭后重新打开最新版本，再合并修改。</p> : null}
          <footer className="dialog-actions field-wide">
            <button className="button button-ghost" type="button" onClick={requestClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting || sourceChanged}><Check aria-hidden="true" size={17} />{submitting ? "正在保存..." : "保存人工版本"}</button>
          </footer>
        </form>
        {discardPromptOpen ? <div className="dialog-backdrop new-run-discard-backdrop" role="presentation">
          <section className="decision-dialog" aria-labelledby="episode-discard-title">
            <header className="dialog-header"><div><p className="eyebrow">未保存的修改</p><h2 id="episode-discard-title">要放弃这集的修改吗？</h2></div></header>
            <div className="decision-dialog-copy"><AlertCircle aria-hidden="true" size={22} /><div><p>未保存的标题、开场和承接要求会丢失。</p><p>不会保存新版本、进入制作或调用模型。</p></div></div>
            <footer className="dialog-actions">
              <button className="button button-primary" type="button" data-dialog-initial-focus onClick={() => setDiscardPromptOpen(false)}>返回填写</button>
              <button className="button button-danger-ghost" type="button" onClick={onClose}>放弃并关闭</button>
            </footer>
          </section>
        </div> : null}
      </section>
    </div>
  );
}

function required(data: FormData, key: string): string {
  const value = data.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error("请完整填写单集路线图。");
  return value.trim();
}

function lines(data: FormData, key: string): string[] {
  const value = data.get(key);
  return typeof value === "string"
    ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : [];
}
