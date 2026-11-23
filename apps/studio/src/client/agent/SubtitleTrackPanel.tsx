import { useRef, useState } from "react";
import { Captions, Scissors } from "lucide-react";
import type { ArtifactRevision, RevisionRef, SubtitleCue, SubtitleCues, SubtitleReceipt, SubtitleStyle, SubtitleTrack } from "../../shared/agent/generated/contracts.js";
import { agentApi } from "./api.js";
import { useRevisionCommand } from "./useRevisionCommand.js";
import { subtitleDownloadUrl, subtitleStyles, useReviewEdit, type ReviewBuffers } from "./review-edits.js";
import "./review-media-tools.css";

export function SubtitleDownloads({ source }: { source: RevisionRef }) {
  return <span className="frame-caption-downloads"><a download href={subtitleDownloadUrl(source, "srt")}>下载 SRT</a><a download href={subtitleDownloadUrl(source, "vtt")}>下载 VTT</a></span>;
}
export function StylePicker({ value, onChange }: { value: SubtitleStyle; onChange: (value: SubtitleStyle) => void }) {
  return <label className="frame-caption-style">字幕样式<select value={value} onChange={e => onChange(e.currentTarget.value as SubtitleStyle)}>
    {Object.entries(subtitleStyles).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></label>;
}
function time(ms: number) {
  return `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}
type CueEdit = Omit<SubtitleCue, "startMs" | "endMs"> & { startMs: string; endMs: string };
const PAGE = 12;
const toDraft = (cue: SubtitleCue): CueEdit => ({ ...cue, startMs: String(cue.startMs), endMs: String(cue.endMs) });
export function SubtitleTrackPanel({ revision, track, editor }: { revision: ArtifactRevision; track: SubtitleTrack;
  editor?: { buffers: ReviewBuffers; onSaved: (ref: RevisionRef) => void } | undefined;
}) {
  const [editing, setEditing] = useState(false), [page, setPage] = useState(0);
  const [localBuffers] = useState<ReviewBuffers>(() => new Map());
  const key = `captions:${revision.artifactId}:${revision.revisionId}`;
  const edits = useReviewEdit(editor?.buffers ?? localBuffers, key, { stylePreset: track.stylePreset, cues: track.cues.map(toDraft) });
  const command = useRevisionCommand<SubtitleReceipt>();
  const [problem, setProblem] = useState("");
  const texts = useRef(new Map<string, HTMLTextAreaElement>());
  const active = editing && Boolean(editor), cues = active ? edits.value.cues : track.cues;
  const change = (next: CueEdit[]) => { setProblem(""); edits.change({ ...edits.value, cues: next }); };
  const update = (i: number, patch: Partial<CueEdit>) => change(edits.value.cues.map((cue, n) => n === i ? { ...cue, ...patch } : cue));
  const split = (i: number) => {
    const cue = edits.value.cues[i]!, at = texts.current.get(cue.id)!.selectionStart;
    const before = cue.text.slice(0, at).trim(), after = cue.text.slice(at).trim();
    const start = Number(cue.startMs), end = Number(cue.endMs);
    if (!before || !after || end - start < 2) { setProblem("请把光标放在要断开的两个字之间，并留出至少 2 毫秒。"); return; }
    const boundary = String(Math.max(start + 1, Math.min(end - 1, Math.round(start + (end - start) * at / cue.text.length))));
    const rows = [...edits.value.cues];
    rows.splice(i, 1, { ...cue, text: before, endMs: boundary }, { ...cue, id: crypto.randomUUID(), text: after, startMs: boundary });
    change(rows);
  };
  const merge = (i: number) => {
    const rows = [...edits.value.cues], a = rows[i]!, b = rows[i + 1]!;
    const space = /[A-Za-z0-9]$/.test(a.text) && /^[A-Za-z0-9]/.test(b.text) ? " " : "";
    rows.splice(i, 2, { ...a, endMs: b.endMs, text: a.text.trimEnd() + space + b.text.trimStart() });
    change(rows); setPage(Math.min(page, Math.ceil(rows.length / PAGE) - 1));
  };
  const save = async () => {
    const result = edits.value.cues.map(cue => ({ ...cue, text: cue.text.trim(), startMs: Number(cue.startMs), endMs: Number(cue.endMs) }));
    const invalid = result.findIndex((cue, i) => !cue.text || cue.text.length > 2000 ||
      edits.value.cues[i]!.startMs === "" || !Number.isInteger(cue.startMs) || !Number.isInteger(cue.endMs) ||
      cue.startMs < 0 || cue.endMs > 86400000 || cue.startMs >= cue.endMs || (i > 0 && cue.startMs < result[i - 1]!.endMs));
    if (invalid >= 0) { setProblem(`第 ${invalid + 1} 句的文字或时间不完整，请按先后顺序填写互不重叠的起止时间。`); setPage(Math.floor(invalid / PAGE)); return; }
    const receipt = await command.submit({ expectedRevision: revision.revisionNumber, baseRevisionId: revision.revisionId,
      stylePreset: edits.value.stylePreset, cues: result as SubtitleCues }, body => agentApi.saveSubtitleRevision(revision.artifactId, body));
    if (receipt) { edits.clear(); setEditing(false); editor?.onSaved(receipt.artifact); }
  };
  return <section className="frame-caption-track" aria-label="字幕轨道">
    <header><span><Captions /> {track.cues.length} 句 · {track.alignment === "tts_word" ? "配音词边界" : "本地语音转写"}</span><SubtitleDownloads source={revision} /></header>
    {active ? <form onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={command.busy}><StylePicker value={edits.value.stylePreset} onChange={stylePreset => edits.change({ ...edits.value, stylePreset })} />
        <ol className="frame-caption-cues" start={page * PAGE + 1}>{edits.value.cues.slice(page * PAGE, (page + 1) * PAGE).map((cue, offset) => {
          const i = page * PAGE + offset, next = edits.value.cues[i + 1];
          return <li key={cue.id}><div className="frame-caption-timing"><strong>第 {i + 1} 句</strong>
            <label>起（ms）<input type="number" min={0} max={86399999} required aria-label={`第 ${i + 1} 句开始毫秒`} value={cue.startMs} onChange={e => update(i, { startMs: e.target.value })} /></label>
            <label>止（ms）<input type="number" min={1} max={86400000} required aria-label={`第 ${i + 1} 句结束毫秒`} value={cue.endMs} onChange={e => update(i, { endMs: e.target.value })} /></label></div>
            <textarea aria-label={`第 ${i + 1} 句字幕`} rows={2} required maxLength={2000} value={cue.text} ref={element => { if (element) texts.current.set(cue.id, element); else texts.current.delete(cue.id); }} onChange={e => update(i, { text: e.target.value })} />
            <div className="frame-caption-actions"><button type="button" disabled={edits.value.cues.length >= 10000} onClick={() => split(i)}><Scissors />在光标处断句</button>
              {next && next.speaker === cue.speaker ? <button type="button" onClick={() => merge(i)}>合并下一句</button> : null}</div></li>;
        })}</ol>
        <div className="frame-caption-actions"><button type="submit" className="frame-edit-primary" disabled={!edits.dirty}>{command.busy ? "正在保存…" : "保存为新版本"}</button>
          <button type="button" onClick={() => { setEditing(false); setPage(0); setProblem(""); }}>收起校对</button></div>
      </fieldset>
      {problem || command.error ? <p role="alert">{problem || command.error}</p> : null}
    </form> : <><div className="frame-caption-meta"><span>{subtitleStyles[track.stylePreset]}</span>{editor ? <button type="button" onClick={() => { setPage(0); setEditing(true); }}>{edits.dirty ? "继续校对字幕" : "校对字幕"}</button> : null}</div>
      <ol className="frame-caption-read">{track.cues.slice(page * PAGE, (page + 1) * PAGE).map(cue => <li key={cue.id}><time>{time(cue.startMs)}–{time(cue.endMs)}</time><span>{cue.speaker ? <small>{cue.speaker} · </small> : null}{cue.text}</span></li>)}</ol></>}
    {cues.length > PAGE ? <nav aria-label="字幕分页"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(cues.length / PAGE)}</span><button type="button" disabled={(page + 1) * PAGE >= cues.length} onClick={() => setPage(page + 1)}>下一页</button></nav> : null}
  </section>;
}
