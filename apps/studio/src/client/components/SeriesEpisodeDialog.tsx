import { AlertCircle, Check, PencilLine, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
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

export function SeriesEpisodeDialog({ open, series, episode, onClose, onSubmit }: SeriesEpisodeDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) setError(undefined);
  }, [open]);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section ref={dialogRef} className="run-dialog series-episode-dialog" role="dialog" aria-modal="true" aria-labelledby="series-episode-dialog-title" tabIndex={-1}>
        <header className="dialog-header">
          <div><p className="eyebrow">路线图人工修订</p><h2 id="series-episode-dialog-title">编辑第 {episode.episodeNumber} 集</h2><p>保存后会保留人工溯源；后续编剧、导演与审片 Agent 仍会基于你的版本独立审计。</p></div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭"><X aria-hidden="true" size={19} /></button>
        </header>
        <form className="run-form series-episode-form" onSubmit={submit}>
          <label className="field"><span>内容支柱</span><select name="pillar" defaultValue={episode.pillar}>{series.pillars.map((pillar) => <option key={pillar} value={pillar}>{pillar}</option>)}</select></label>
          <label className="field field-wide"><span>单集标题</span><input name="title" defaultValue={episode.title} required data-dialog-initial-focus /></label>
          <label className="field field-wide"><span>这一集给观众什么</span><textarea name="viewerPromise" defaultValue={episode.viewerPromise} rows={2} required /></label>
          <label className="field field-wide"><span>开场钩子</span><textarea name="hook" defaultValue={episode.hook} rows={2} required /></label>
          <label className="field field-wide"><span>本集必须兑现</span><textarea name="payoff" defaultValue={episode.payoff} rows={2} required /></label>
          <label className="field"><span>本集额外承接要求</span><textarea name="fromPrevious" defaultValue={episode.continuity.fromPrevious.join("\n")} rows={3} placeholder="每行一项；系统继承的正史交接会单独保留" /></label>
          <label className="field"><span>留给下一集</span><textarea name="toNext" defaultValue={episode.continuity.toNext.join("\n")} rows={3} placeholder="每行一项" /></label>
          <p className="series-edit-notice field-wide"><PencilLine aria-hidden="true" size={16} /><span><strong>人工版本优先</strong> 系统不会把路线图 Agent 的旧结果悄悄覆盖回来。保存后，原策划审计会标为已失效。</span></p>
          {error ? <p className="form-error field-wide" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          <footer className="dialog-actions field-wide">
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting}><Check aria-hidden="true" size={17} />{submitting ? "正在保存..." : "保存人工版本"}</button>
          </footer>
        </form>
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
