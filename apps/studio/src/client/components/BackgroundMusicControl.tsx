import { useEffect, useRef, useState } from "react";
import type { StudioBackgroundMusic } from "../../shared/api.js";
import { studioApi } from "../api.js";

export function BackgroundMusicControl({ value, onChange, onBusyChange }: {
  value: StudioBackgroundMusic | undefined;
  onChange: (music: StudioBackgroundMusic | undefined) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [file, setFile] = useState<File>();
  const [licenseNote, setLicenseNote] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; onBusyChange(false); }, [onBusyChange]);
  async function upload() {
    if (!file || busy) return;
    const request = ++generation.current;
    setBusy(true); onBusyChange(true); setError(undefined);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("请选择 20 MB 以内的音乐文件。");
      const uploaded = await studioApi.uploadBackgroundMusic(file, licenseNote);
      if (generation.current !== request) return;
      onChange({ ...uploaded, volume: 0.25, fadeInSeconds: 1, fadeOutSeconds: 1.5, ducking: true });
      setFile(undefined);
    } catch (caught) {
      if (generation.current === request) setError(caught instanceof Error ? caught.message : "音乐上传失败。");
    } finally {
      if (generation.current === request) { setBusy(false); onBusyChange(false); }
    }
  }
  return <details className="brief-extra-options background-music-control">
    <summary>背景音乐（可选）<span>{value ? value.label : "未添加"}</span></summary>
    <div className="brief-extra-fields">
      <p className="form-help">上传你有权使用的音乐，渲染时循环铺底并淡出。不会生成音乐或增加模型调用。</p>
      {value ? <>
        <strong>{value.label}</strong>
        <audio aria-label="试听背景音乐原曲" controls preload="none" src={`/api/background-music/${encodeURIComponent(value.uploadId)}`} />
        <small>这里试听原曲；混音效果在成片中确认。授权来源：{value.licenseNote}</small>
        <label className="field"><span>音乐音量 {Math.round(value.volume * 100)}%</span>
          <input aria-label="音乐音量" type="range" min="0" max="0.5" step="0.01" value={value.volume}
            onChange={event => onChange({ ...value, volume: Number(event.target.value) })} /></label>
        <label><input type="checkbox" checked={value.ducking} onChange={event => onChange({ ...value, ducking: event.target.checked })} />人声出现时降低音乐音量</label>
        <label className="field"><span>淡入（秒）</span><input aria-label="音乐淡入秒数" type="number" min="0" max="5" step="0.5" value={value.fadeInSeconds}
          onChange={event => onChange({ ...value, fadeInSeconds: Math.max(0, Math.min(5, Number(event.target.value))) })} /></label>
        <label className="field"><span>淡出（秒）</span><input aria-label="音乐淡出秒数" type="number" min="0" max="5" step="0.5" value={value.fadeOutSeconds}
          onChange={event => onChange({ ...value, fadeOutSeconds: Math.max(0, Math.min(5, Number(event.target.value))) })} /></label>
        <button type="button" className="button button-ghost" onClick={() => onChange(undefined)}>本片不加音乐</button>
      </> : <>
        <label className="field"><span>音乐文件</span><input aria-label="音乐文件" type="file" accept="audio/mpeg,audio/wav,audio/mp4,audio/flac,audio/ogg,.mp3,.wav,.m4a,.flac,.ogg" disabled={busy}
          onChange={event => setFile(event.target.files?.[0])} /><small>最长 10 分钟，最大 20 MB。</small></label>
        <label className="field"><span>授权或来源说明</span><input aria-label="音乐授权或来源说明" maxLength={500} value={licenseNote} disabled={busy}
          placeholder="例如：本人创作，或已授权的曲目及来源链接" onChange={event => setLicenseNote(event.target.value)} /></label>
        <button type="button" className="button button-secondary" disabled={!file || !licenseNote.trim() || busy} onClick={() => void upload()}>{busy ? "上传并检查中…" : "使用这首音乐"}</button>
      </>}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  </details>;
}
