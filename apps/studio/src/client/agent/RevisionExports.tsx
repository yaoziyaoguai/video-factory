import { Download } from "lucide-react";
import type { ArtifactRevision, RevisionRef } from "../../shared/agent/generated/contracts.js";
import { blobUrl } from "./review-content.js";
import { subtitleDownloadUrl } from "./review-edits.js";

const timelines = [["fcpxml", "Final Cut Pro XML"], ["otio", "OpenTimelineIO"], ["jianying", "剪映草稿"]] as const;

export function RevisionExports({ revision, mainProject, projects = [], finalized = false }: {
  revision: ArtifactRevision; mainProject?: RevisionRef | null | undefined; projects?: RevisionRef[] | undefined; finalized?: boolean | undefined;
}) {
  const { content, creationBinding, runId } = revision;
  const media = content.format === "media" ? content : null;
  const primary = content.format === "project" ? revision : creationBinding?.projectRevision ?? mainProject;
  const all = new Map<string, RevisionRef>();
  if (primary) all.set(primary.revisionId, primary);
  for (const ref of [...(creationBinding?.projectRevisions ?? []), ...projects]) all.set(ref.revisionId, ref);
  if (media && !finalized && (!media.mimeType.startsWith("video/") || (!media.subtitles && !runId && !all.size))) {
    return <a href={blobUrl(media.blobId)} download>下载文件</a>;
  }
  return <details className="frame-export-menu" onToggle={event => {
    if (event.currentTarget.open) event.currentTarget.querySelector(".frame-export-links")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }} onKeyDown={event => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}>
    <summary><Download aria-hidden="true" />导出</summary>
    <div className="frame-export-links" aria-label="当前版本的导出文件">
      {/* 工程包与字幕的服务器响应携带 attachment。错误时应打开真实原因，且保留审阅中的页面。 */}
      {media ? <a download href={blobUrl(media.blobId)}>{media.mimeType === "video/mp4" ? "下载 MP4 成片" : "下载原始文件"}</a> : null}
      {media?.subtitles ? <><a target="_blank" rel="noopener" href={subtitleDownloadUrl(revision,"srt")}>下载 SRT</a><a target="_blank" rel="noopener" href={subtitleDownloadUrl(revision,"vtt")}>下载 VTT</a></> : null}
      {media?.mimeType.startsWith("video/") && runId ? timelines.map(([format, label]) => <a key={format} target="_blank" rel="noopener" href={`/api/agent/v1/runs/${encodeURIComponent(runId)}/export?format=${format}&revisionId=${encodeURIComponent(revision.revisionId)}`}>{label} 工程包</a>) : null}
      {[...all.values()].map((ref, index) => {
        const boundRun = content.format !== "project" && primary?.revisionId === ref.revisionId ? runId : null;
        const link = `/api/agent/v1/artifacts/${encodeURIComponent(ref.artifactId)}/revisions/${encodeURIComponent(ref.revisionId)}/archive.zip`;
        const name = all.size === 1 ? "工程 ZIP（含署名）" : primary?.revisionId === ref.revisionId ? "主工程 ZIP（含署名）" : `来源工程 ${primary ? index : index + 1} ZIP（含署名）`;
        return <a target="_blank" rel="noopener" key={ref.revisionId} href={link + (boundRun ? "?runId=" + encodeURIComponent(boundRun) : "")}>{name}</a>;
      })}
      {finalized && !runId ? <small>未记录这版成片的制作来源，无法导出剪辑时间线。</small> : null}
    </div>
  </details>;
}
