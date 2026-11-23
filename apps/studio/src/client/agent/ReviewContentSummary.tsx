import { memo, useCallback, useRef } from "react";
import { ArrowUpRight, Check, FileText, Film, Images, Music2 } from "lucide-react";
import type { ArtifactRevision, ContentSource, ReviewGroup, ReviewItem } from "../../shared/agent/generated/contracts.js";
import { sameSource, useNearViewport, useStageRevision } from "./review-content.js";
import { RevisionCover, mediaDuration, revisionExcerpt } from "./RevisionCover.js";

const THUMB_ROLES = new Set(["video", "clip", "character", "scene", "storyboard"]);

interface ReviewContentProps {
  item: ReviewItem; group: ReviewGroup; source: ContentSource; approved: boolean; revisions: Record<string, ArtifactRevision>;
  onRevisionLoaded?: ((revision: ArtifactRevision) => void) | undefined; onOpen: (source: ContentSource) => void;
  active: boolean; compact?: boolean; selected?: boolean; accessibleLabel?: string;
  /** 总览行左列主封面所指的修订：同修订的卡片不再重复渲染小缩略图。 */
  rowCover?: ContentSource | null;
}

export function ReviewContentSummary(props: ReviewContentProps) {
  const open = useRef(props.onOpen);
  open.current = props.onOpen;
  const onOpen = useCallback((source: ContentSource) => open.current(source), []);
  return <ReviewCard {...props} onOpen={onOpen} />;
}

const ReviewCard = memo(function ReviewCard({ item, source, approved, revisions, onRevisionLoaded, onOpen, active, compact = false, selected = false, accessibleLabel, rowCover = null }: ReviewContentProps) {
  const [element, visible] = useNearViewport<HTMLElement>();
  const { revision, error, retry } = useStageRevision(visible ? source : null, revisions, onRevisionLoaded, active);
  const media = revision?.content.format === "media" ? revision.content : null;
  const excerpt = revisionExcerpt(revision, source);
  const Icon = media?.mimeType.startsWith("audio/") ? Music2 : media?.mimeType.startsWith("image/") ? Images : media || item.role === "video" ? Film : FileText;
  const version = revision ? `v${revision.revisionNumber}` : "";
  // UIUX-02 总览缩略图：视觉角色或已加载图片/视频修订渲染 48px 缩略图；与本行主封面同修订时省略重复小图。
  const visualThumb = media !== null && (THUMB_ROLES.has(item.role) || media.mimeType.startsWith("image/") || media.mimeType.startsWith("video/"));
  const showCover = media !== null && (compact || (visualThumb && !sameSource(source, rowCover)));
  return <article ref={element} className={`agent-delivery-card${compact ? " compact" : ""}`} data-selected={selected || undefined} data-state={approved ? "approved" : "pending"}>
    <button type="button" className="agent-delivery-open" onClick={() => onOpen(source)} aria-current={selected ? "true" : undefined} aria-label={accessibleLabel ?? `${approved ? "查看已确认" : "审阅"}${item.label}${version ? " " + version : ""}`}>
      {showCover ? <RevisionCover revision={revision} /> : null}
      <span className="agent-delivery-title"><Icon /><strong>{item.label}</strong>{version ? <span>{version}</span> : null}</span>
      {excerpt ? <span className="agent-delivery-excerpt">{excerpt.slice(0, 180)}</span> : media?.durationMs != null ? <small className="agent-item-duration">{mediaDuration(media.durationMs)}</small> : null}
      {error ? <small>内容读取失败</small> : null}
      <span className="agent-delivery-footer">{approved ? <><Check />{sameSource(item.approved, item.draft) ? "已确认" : "上一认可版"}</> : <>审阅{version ? " " + version : "这版"}<ArrowUpRight /></>}</span>
    </button>
    {error ? <button type="button" className="agent-delivery-retry" onClick={retry}>重新读取</button> : null}
  </article>;
});
