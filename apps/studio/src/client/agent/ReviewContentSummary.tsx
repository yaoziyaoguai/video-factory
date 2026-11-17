import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, FileText, Image, Layers, Music2, Play } from "lucide-react";
import type { ArtifactRevision, ContentSource, ReviewGroup, ReviewItem } from "../../shared/agent/generated/contracts.js";
import { sameSource, useStageRevision } from "./review-content.js";

const blobUrl = (id: string) => `/api/agent/v1/blobs/${encodeURIComponent(id)}/content`;

export function ReviewContentSummary({ item, group, source, approved, revisions, onRevisionLoaded, onOpen, active, compact = false, selected = false, accessibleLabel }: {
  item: ReviewItem; group: ReviewGroup; source: ContentSource; approved: boolean; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined; onOpen: (source: ContentSource) => void;
  active: boolean; compact?: boolean; selected?: boolean; accessibleLabel?: string;
}) {
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [mediaError, setMediaError] = useState(false);
  // 总览仅读取靠近视口的准确修订；长对话不会一次打开所有正文和视频。
  useEffect(() => {
    if (visible || !element.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "160px" });
    observer.observe(element.current);
    return () => observer.disconnect();
  }, [visible]);
  const { revision, error, retry } = useStageRevision(visible ? source : null, revisions, onRevisionLoaded, active);
  useEffect(() => setMediaError(false), [revision?.revisionId]);
  const content = revision?.content;
  const text = source.kind === "message_text" ? source.text : content?.format === "markdown" ? [content.text, ...content.sections?.slice(0, 2).map(section => `${section.title}\n${section.text}`) ?? []].join("\n") : null;
  const media = content?.format === "media" ? content : null;
  return <article ref={element} className={`agent-delivery-card${compact ? " compact" : ""}`} data-selected={selected || undefined} data-state={approved ? "approved" : "pending"}>
    <button type="button" className="agent-delivery-open" onClick={() => onOpen(source)} aria-current={selected ? "true" : undefined} aria-label={accessibleLabel ?? `${approved ? "查看已确认" : "审阅"}${item.label}${revision ? ` v${revision.revisionNumber}` : ""}`}>
      <div className="agent-delivery-title"><strong>{item.label}</strong>{revision ? <span>v{revision.revisionNumber}</span> : null}</div>
      {media && !mediaError ? <div className="agent-delivery-preview">{media.mimeType.startsWith("image/") ? <img alt="" src={blobUrl(media.blobId)} loading="lazy" onError={() => setMediaError(true)} />
        : media.mimeType.startsWith("video/") ? <><video src={`${blobUrl(media.blobId)}#t=0.1`} preload={visible ? "metadata" : "none"} muted playsInline aria-hidden="true" tabIndex={-1} onError={() => setMediaError(true)} /><span className="agent-delivery-play"><Play /></span></> : <div className="agent-delivery-audio"><Music2 /><span>音频</span></div>}
        {media.durationMs !== null ? <span className="agent-delivery-duration">{Math.floor(media.durationMs / 60000)}:{Math.floor(media.durationMs / 1000 % 60).toString().padStart(2, "0")}</span> : null}</div>
        : text ? <p className="agent-delivery-excerpt">{text.slice(0, 260).replace(/^#{1,6}\s/gm, "")}</p>
        : <div className="agent-delivery-placeholder">{mediaError ? <><Image />预览暂不可用</> : error ? <><FileText />内容读取失败</> : content ? <><Layers />{content.format === "project" ? "制作工程" : "文件"}</> : <><FileText />{visible ? "正在读取…" : "打开查看内容"}</>}</div>}
      <div className="agent-delivery-footer"><span>{approved ? <><Check />{!sameSource(item.approved, item.draft) ? "已有新草稿" : "已确认"}</> : "审阅这版"}</span><ArrowUpRight /></div>
    </button>
    {error ? <button type="button" className="agent-delivery-retry" onClick={retry}>重新读取</button> : null}
  </article>;
}
