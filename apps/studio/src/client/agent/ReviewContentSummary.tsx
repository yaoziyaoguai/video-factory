import { ArrowUpRight, Check, FileText, Film, Images, Music2 } from "lucide-react";
import type { ArtifactRevision, ContentSource, ReviewGroup, ReviewItem } from "../../shared/agent/generated/contracts.js";
import { sameSource, useNearViewport, useStageRevision } from "./review-content.js";
import { RevisionCover, mediaDuration, revisionExcerpt } from "./RevisionCover.js";

export function ReviewContentSummary({ item, source, approved, revisions, onRevisionLoaded, onOpen, active, compact = false, selected = false, accessibleLabel }: {
  item: ReviewItem; group: ReviewGroup; source: ContentSource; approved: boolean; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined; onOpen: (source: ContentSource) => void;
  active: boolean; compact?: boolean; selected?: boolean; accessibleLabel?: string;
}) {
  const [element, visible] = useNearViewport<HTMLElement>();
  const { revision, error, retry } = useStageRevision(visible ? source : null, revisions, onRevisionLoaded, active);
  const media = revision?.content.format === "media" ? revision.content : null;
  const excerpt = revisionExcerpt(revision, source);
  const Icon = media?.mimeType.startsWith("audio/") ? Music2 : media?.mimeType.startsWith("image/") ? Images : media || item.role === "video" ? Film : FileText;
  const version = revision ? `v${revision.revisionNumber}` : "";
  return <article ref={element} className={`agent-delivery-card${compact ? " compact" : ""}`} data-selected={selected || undefined} data-state={approved ? "approved" : "pending"}>
    <button type="button" className="agent-delivery-open" onClick={() => onOpen(source)} aria-current={selected ? "true" : undefined} aria-label={accessibleLabel ?? `${approved ? "查看已确认" : "审阅"}${item.label}${version ? " " + version : ""}`}>
      {compact && media ? <RevisionCover revision={revision} /> : null}
      <span className="agent-delivery-title"><Icon /><strong>{item.label}</strong>{version ? <span>{version}</span> : null}</span>
      {excerpt ? <span className="agent-delivery-excerpt">{excerpt.slice(0, 180)}</span> : media?.durationMs != null ? <small className="agent-item-duration">{mediaDuration(media.durationMs)}</small> : null}
      {error ? <small>内容读取失败</small> : null}
      <span className="agent-delivery-footer">{approved ? <><Check />{sameSource(item.approved, item.draft) ? "已确认" : "上一认可版"}</> : <>审阅{version ? " " + version : "这版"}<ArrowUpRight /></>}</span>
    </button>
    {error ? <button type="button" className="agent-delivery-retry" onClick={retry}>重新读取</button> : null}
  </article>;
}
