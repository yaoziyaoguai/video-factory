import { blobUrl } from "./review-content.js";
import { useState } from "react";
import { FileText, ImageOff, Music2 } from "lucide-react";
import type { ArtifactRevision, ContentSource } from "../../shared/agent/generated/contracts.js";

export function mediaDuration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function revisionExcerpt(revision?: ArtifactRevision | null, source?: ContentSource | null) {
  const content = revision?.content;
  if (source?.kind === "message_text") return source.text;
  if (content?.format !== "markdown") return "";
  return [content.text, ...(content.sections ?? []).slice(0, 2).map(section => section.text)].join("\n").trim().replace(/^#{1,6}\s/gm, "");
}

// 封面、时长和文稿摘录来自所指的同一修订。长列表不创建视频播放器。
export function RevisionCover({ revision, source, unavailable = false }: {
  revision?: ArtifactRevision | null | undefined; source?: ContentSource | null | undefined; unavailable?: boolean;
}) {
  const content = revision?.content;
  const media = content?.format === "media" ? content : null;
  const [failed, setFailed] = useState("");
  const url = media?.mimeType.startsWith("video/") ? blobUrl(media.blobId, "poster") : media?.mimeType.startsWith("image/") ? blobUrl(media.blobId) : "";
  const excerpt = revisionExcerpt(revision, source);
  return <span className="agent-revision-cover">
    {url && failed !== url ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(url)} />
      : media?.mimeType.startsWith("audio/") ? <span className="agent-cover-excerpt"><Music2 />音频</span>
      : excerpt ? <span className="agent-cover-excerpt"><FileText /><span>{excerpt.slice(0, 82)}</span></span>
      : <span className="agent-cover-placeholder">{Boolean(url && failed === url) || unavailable ? <><ImageOff />封面暂不可用</> : revision || !source ? <FileText /> : "读取中…"}</span>}
    {media?.durationMs != null ? <small className="agent-cover-duration">{mediaDuration(media.durationMs)}</small> : null}
  </span>;
}
