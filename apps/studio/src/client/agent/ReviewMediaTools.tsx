import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import type { ArtifactRevision, LocalCreationReceipt, RemixCommand, RemixTimeline, RenderSubtitles, RevisionRef, SubtitleReceipt, SubtitleStyle, Work } from "../../shared/agent/generated/contracts.js";
import { agentApi } from "./api.js";
import { useRevisionCommand } from "./useRevisionCommand.js";
import { StylePicker } from "./SubtitleTrackPanel.js";
import { useReviewEdit, type ReviewBuffers } from "./review-edits.js";
import "./review-media-tools.css";

type EditableTimeline = Extract<RemixTimeline, { available: true }>;
type Cut = { id: string; startMs: string; durationMs: string };
function Gain({ label, value, change }: { label: string; value: number; change: (value: number) => void }) {
  return <label className="frame-remix-gain"><span>{label}</span><input type="range" aria-label={label} min={0} max={100} step={1} value={Math.round(value * 100)} onChange={e => change(Number(e.target.value) / 100)} /><output>{Math.round(value * 100)}%</output></label>;
}
function CutPoint({ label, value, min, max, change, index }: { label: string; value: string; min: number; max?: number | undefined; change: (value: string) => void; index: number }) {
  return <div className="frame-cut-control"><span>{label}</span>{max !== undefined ? <input type="range" aria-label={`镜头 ${index} ${label}滑块`} min={min} max={max} step={1} value={value} onChange={e => change(e.target.value)} /> : null}
    <label><input type="number" aria-label={`镜头 ${index} ${label}毫秒`} min={min} max={max} step={1} required value={value} onChange={e => change(e.target.value)} /> ms</label></div>;
}
function RemixEditor({ timeline, runId, work, buffers, onRun, revisions }: {
  timeline: EditableTimeline; runId: string; work: Work; buffers: ReviewBuffers; onRun: (runId: string) => void; revisions: Record<string, ArtifactRevision>;
}) {
  const arr = timeline.segments.map(s => ({ id: s.id, startMs: String(s.startMs), durationMs: String(s.durationMs) }));
  const edit = useReviewEdit(buffers, `remix:${timeline.base.revisionId}`, {
    cuts: arr, originalGain: null as number | null, narrationGain: timeline.narrationGain, musicGain: timeline.musicGain,
    duck: timeline.duckUnderNarration, subtitles: timeline.subtitles as RenderSubtitles | null,
  });
  const { value } = edit, command = useRevisionCommand<LocalCreationReceipt>();
  const [drag, setDrag] = useState<string | null>(null), [issue, setIssue] = useState("");
  const patch = (next: Partial<typeof value>) => { setIssue(""); command.clearReceipt(); edit.change({ ...value, ...next }); };
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= value.cuts.length) return;
    const cuts = [...value.cuts]; cuts.splice(to, 0, cuts.splice(from, 1)[0]!); patch({ cuts });
  };
  const setCut = (id: string, update: Partial<Cut>) => patch({ cuts: value.cuts.map(cut => cut.id === id ? { ...cut, ...update } : cut) });
  const originals = timeline.segments.flatMap(segment => segment.originalGain === null ? [] : [segment.originalGain]);
  const gainsDiffer = new Set(originals).size > 1;
  const tracks = new Map(work.reviewGroups.flatMap(group => group.items.flatMap(item => {
    const ref = item.role === "subtitle" ? item.approved : null;
    if (ref?.kind !== "artifact_revision") return [];
    const version = revisions[`${ref.artifactId}:${ref.revisionId}`]?.revisionNumber;
    return [[ref.revisionId, { ref: { artifactId: ref.artifactId, revisionId: ref.revisionId }, label: `${item.label} · ${version ? `v${version}` : "已认可版"}` }] as const];
  })));
  const existing = timeline.subtitles;
  const submit = async () => {
    const segments = value.cuts.map(cut => ({ id: cut.id, startMs: Number(cut.startMs), durationMs: Number(cut.durationMs) })) as RemixCommand["segments"];
    const subtitleChanged = value.subtitles?.track.revisionId !== existing?.track.revisionId || value.subtitles?.mode !== existing?.mode;
    const input = { expectedRevision: timeline.revision, baseRevisionId: timeline.base.revisionId, segments,
      ...(value.originalGain === null ? {} : { originalGain: value.originalGain }),
      ...(value.narrationGain !== timeline.narrationGain && value.narrationGain !== null ? { narrationGain: value.narrationGain } : {}),
      ...(value.musicGain !== timeline.musicGain && value.musicGain !== null ? { musicGain: value.musicGain } : {}),
      ...(value.duck !== timeline.duckUnderNarration ? { duckUnderNarration: value.duck } : {}),
      ...(subtitleChanged ? { subtitles: value.subtitles } : {}),
    };
    const invalid = segments.findIndex(cut => { const source = timeline.segments.find(s => s.id === cut.id)!;
      return cut.durationMs < 1 || cut.startMs < 0 || (source.sourceDurationMs !== null && source.kind === "video" && cut.startMs + cut.durationMs > source.sourceDurationMs); });
    if (invalid >= 0) { setIssue(`第 ${invalid + 1} 个镜头的切点超出源素材，请缩短时长或提前进点。`); return; }
    await command.submit(input, body => agentApi.remixRun(runId, body));
  };
  return <details className="frame-refinement frame-remix"><summary>微调时间线与混音</summary>
    <form onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset disabled={command.busy}>
      <ol className="frame-remix-cuts" aria-label="剪辑时间线">{value.cuts.map((cut, index) => {
        const source = timeline.segments.find(s => s.id === cut.id)!;
        const availableDuration = source.kind === "video" && source.sourceDurationMs !== null ? Math.min(120000, source.sourceDurationMs - Number(cut.startMs)) : 120000;
        return <li key={cut.id} onDragOver={e => { if (drag !== null) e.preventDefault(); }} onDrop={e => { if (drag !== null) { e.preventDefault(); move(value.cuts.findIndex(c => c.id === drag), index); setDrag(null); } }}>
          <header><span draggable onDragStart={e => { setDrag(cut.id); e.dataTransfer.setData("text/plain", cut.id); e.dataTransfer.effectAllowed = "move"; }} onDragEnd={() => setDrag(null)} title="拖动调整顺序"><GripVertical /></span>
            <strong>{index + 1}. {source.label}</strong><button type="button" aria-label={`上移 ${source.label}`} disabled={index === 0} onClick={() => move(index, index - 1)}><ArrowUp /></button>
            <button type="button" aria-label={`下移 ${source.label}`} disabled={index + 1 === value.cuts.length} onClick={() => move(index, index + 1)}><ArrowDown /></button></header>
          {source.kind === "video" ? <CutPoint label="进点" index={index + 1} value={cut.startMs} min={0} max={source.sourceDurationMs === null ? undefined : Math.max(0, source.sourceDurationMs - Number(cut.durationMs))} change={startMs => setCut(cut.id, { startMs })} /> : null}
          <CutPoint label="时长" index={index + 1} value={cut.durationMs} min={1} max={availableDuration} change={durationMs => setCut(cut.id, { durationMs })} />
        </li>;
      })}</ol>
      <div className="frame-remix-mix">
        {gainsDiffer ? <label><input type="checkbox" checked={value.originalGain !== null} onChange={e => patch({ originalGain: e.target.checked ? originals[0]! : null })} />统一调整各镜头原声</label> : null}
        {originals.length > 0 && (!gainsDiffer || value.originalGain !== null) ? <Gain label="原声音量" value={value.originalGain ?? originals[0]!} change={originalGain => patch({ originalGain })} /> : null}
        {value.narrationGain !== null ? <Gain label="配音音量" value={value.narrationGain} change={narrationGain => patch({ narrationGain })} /> : null}
        {value.musicGain !== null ? <Gain label="音乐音量" value={value.musicGain} change={musicGain => patch({ musicGain })} /> : null}
        {timeline.musicGain !== null && timeline.narrationGain !== null ? <label><input type="checkbox" checked={value.duck} onChange={e => patch({ duck: e.target.checked })} />配音时降低音乐</label> : null}
      </div>
      {tracks.size || existing ? <div className="frame-remix-subtitles"><label>字幕轨<select aria-label="字幕轨" value={value.subtitles?.track.revisionId ?? ""} onChange={e => {
        const track = tracks.get(e.target.value)?.ref ?? (e.target.value === existing?.track.revisionId ? existing.track : null);
        patch({ subtitles: track ? { track, mode: value.subtitles?.mode ?? "soft" } : null });
      }}><option value="">不加字幕</option>
        {existing && !tracks.has(existing.track.revisionId) ? <option value={existing.track.revisionId}>沿用此版字幕</option> : null}
        {[...tracks].map(([id, track]) => <option key={id} value={id}>{track.label}</option>)}</select></label>
        {value.subtitles ? <label>呈现方式<select aria-label="呈现方式" value={value.subtitles.mode} onChange={e => patch({ subtitles: { track: value.subtitles!.track, mode: e.target.value as RenderSubtitles["mode"] } })}>
          <option value="soft">软字幕 · 播放时可关闭</option><option value="burn_in">硬字幕 · 烧入画面</option></select></label> : null}</div> : null}
      <div className="frame-caption-actions"><button type="submit" className="frame-edit-primary" disabled={!edit.dirty || !!command.receipt}>{command.busy ? "正在提交…" : "重新合成预览"}</button>
        <span>供应商费用 ¥0.00</span></div>
    </fieldset></form>
    {command.receipt ? <p role="status">已提交本地重合成。<button type="button" onClick={() => onRun(command.receipt!.run.id)}>查看制作记录</button></p> : null}
    {issue || command.error ? <p role="alert">{issue || command.error}</p> : null}
  </details>;
}

export function ReviewMediaTools({ work, source, runId, buffers, onOpen, onRun, revisions }: {
  work: Work; source: RevisionRef; runId: string | null; buffers: ReviewBuffers; onOpen: (ref: RevisionRef) => void; onRun: (id: string) => void;
  revisions: Record<string, ArtifactRevision>;
}) {
  const [style, setStyle] = useState<SubtitleStyle>("clean_bottom"), generate = useRevisionCommand<SubtitleReceipt>();
  const [timeline, setTimeline] = useState<RemixTimeline | null>(null), [error, setError] = useState(""), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!runId) return;
    let current = true;
    void agentApi.remixTimeline(runId, source.revisionId).then(value => { if (current) setTimeline(value); })
      .catch((failure: Error) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [runId, source.revisionId, attempt]);
  return <div className="frame-review-tools">
    <details className="frame-refinement"><summary>生成字幕</summary><div className="frame-caption-generate">
      <StylePicker value={style} onChange={setStyle} /><button type="button" className="frame-edit-primary" disabled={generate.busy || !!generate.receipt}
        onClick={() => void generate.submit({ expectedRevision: work.revision, source, stylePreset: style }, input => agentApi.createSubtitleTrack(work.id, input))}>{generate.busy ? "正在对齐原声…" : "生成字幕初稿"}</button>
      {generate.receipt ? <button type="button" onClick={() => onOpen(generate.receipt!.artifact)}>审阅字幕 v{generate.receipt.revisionNumber}</button> : null}
      {generate.error ? <p role="alert">{generate.error}</p> : null}
    </div></details>
    {timeline?.available && runId ? <RemixEditor key={timeline.base.revisionId} timeline={timeline} work={work} buffers={buffers} runId={runId} revisions={revisions} onRun={onRun} /> : null}
    {error ? <p className="agent-stage-muted">时间线读取失败。<button type="button" title={error} onClick={() => { setError(""); setAttempt(n => n + 1); }}>重试读取时间线</button></p> : null}
  </div>;
}
