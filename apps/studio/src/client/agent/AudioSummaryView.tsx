import type { AudioSummary, MediaProvenance } from "../../shared/agent/generated/contracts.js";
import { MATERIAL_PROVIDER_LABELS } from "./material-labels.js";

// 候选、已采用媒体与冻结声音方案共享来源事实；没有记录的许可/署名不由前端补写。
type SourceDetails = Pick<MediaProvenance, "provider" | "sourceUrl" | "creatorName" | "creatorUrl" | "licenseUrl" | "licenseName" | "licenseVersion" | "usageScope" | "attributionText"> & { acquiredAt?: string };

export function MediaSourceDetails({ source }: { source: SourceDetails }) {
  return <div className="agent-source-details">
    <div className="agent-batch-source">
      <span>{MATERIAL_PROVIDER_LABELS[source.provider] ?? "来源未注明"} · {source.creatorName || "作者未注明"}</span>
      <a href={source.sourceUrl} target="_blank" rel="noreferrer">原素材</a>
      {source.creatorUrl ? <a href={source.creatorUrl} target="_blank" rel="noreferrer">作者主页</a> : null}
      <a href={source.licenseUrl} target="_blank" rel="noreferrer">{source.licenseName || "许可"}</a>
      {source.licenseVersion ? <span>许可版本 {source.licenseVersion}</span> : null}
    </div>
    {source.usageScope ? <p className="agent-source-scope">适用范围：{source.usageScope}</p> : null}
    {source.acquiredAt ? <small>采用于 {new Date(source.acquiredAt).toLocaleString("zh-CN")}</small> : null}
    {source.attributionText ? <label className="agent-source-attribution">发布时请保留署名
      <textarea aria-label="发布署名" readOnly rows={3} value={source.attributionText} />
    </label> : null}
  </div>;
}

const seconds = (ms: number) => (ms / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 });
const volume = (gain: number) => `${(gain * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;

// 只显示服务端的三个固定声音角色，不追溯 inputs，也不把歌曲歌词当作配音。
export function AudioSummaryView({ summary, title = "声音方案" }: { summary: AudioSummary; title?: string }) {
  const { original, music, narration } = summary;
  const keptOriginal = original.filter(item => item.gain > 0 && item.textCoverage !== "muted").length;
  return <section className="agent-audio-summary" aria-label={title}>
    <h4>{title}</h4>
    {original.length ? <details className="agent-audio-original">
      <summary>片段原声 · 保留 {keptOriginal} 段 · 静音 {original.length - keptOriginal} 段</summary>
      <ol>{original.map((item, index) => <li key={`${item.segmentId}:${index}`}>
        <strong>片段 {index + 1} · {item.gain === 0 || item.textCoverage === "muted" ? "原声静音" : `原声音量 ${volume(item.gain)}`}</strong>
        {item.gain === 0 || item.textCoverage === "muted" ? null : item.sourceText !== null
          ? <p className="agent-audio-text">{item.textCoverage === "source_excerpt" ? "来源台词（仅采用其中片段）：" : item.textCoverage === "unknown" ? "已知来源台词（其余原声未知）：" : "来源台词："}{item.sourceText}</p>
          : <p>原声台词未知，未自动转录。</p>}
      </li>)}</ol>
    </details> : <p>未采用片段原声。</p>}
    <div className="agent-audio-role">
      <h5>音乐{music?.gain === 0 ? " · 静音" : ""}</h5>
      {music ? <>
        <strong>{music.source.title || "曲名未记录"}</strong>
        <p>选用原曲 {seconds(music.sourceStartMs)}–{seconds(music.sourceStartMs + music.sourceDurationMs)} 秒；成片 {seconds(music.timelineStartMs)}–{seconds(music.timelineStartMs + music.playDurationMs)} 秒 · {music.repeat ? "循环所选区间" : "不循环"}</p>
        <p>{music.gain === 0 ? "音乐静音" : `音乐音量 ${volume(music.gain)}`} · 淡入 {seconds(music.fadeInMs)} 秒 · 淡出 {seconds(music.fadeOutMs)} 秒{music.gain > 0 && music.duckUnderNarration ? " · 配音时降低音乐" : ""}</p>
        <MediaSourceDetails source={music.source} />
        {!music.source.attributionText ? <p className="agent-stage-muted">署名内容未记录，请核对来源许可。</p> : null}
      </> : <p>未使用音乐。</p>}
    </div>
    <div className="agent-audio-role">
      <h5>独立配音{narration?.gain === 0 ? " · 静音" : ""}</h5>
      {narration ? <>
        <p>{narration.providerName || "提供方未记录"} · {narration.modelName || "型号未记录"} · {narration.voiceName || "音色未记录"}</p>
        <p>成片 {seconds(narration.timelineStartMs)} 秒起 · {narration.gain === 0 ? "配音静音" : `配音音量 ${volume(narration.gain)}`}</p>
        <p className="agent-audio-text">{narration.text === null ? "配音原文未记录。" : `${narration.gain === 0 ? "配音原文（静音）" : "配音原文"}：${narration.text}`}</p>
      </> : <p>未使用独立配音。</p>}
    </div>
  </section>;
}
