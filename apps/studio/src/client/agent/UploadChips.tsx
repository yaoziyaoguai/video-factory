import { useEffect, useState } from "react";
import { AudioLines, FileImage, Film, Paperclip, X } from "lucide-react";
import type { UploadAttachment } from "../../shared/agent/generated/contracts.js";
import type { PendingUpload } from "./useComposerUploads.js";
import { blobUrl } from "./review-content.js";
import { mediaDuration } from "./RevisionCover.js";
import { formatBytes } from "./format-bytes.js";
import "./upload-chips.css";

function FileIcon({ type }: { type: string }) {
  const Icon = type.startsWith("audio/") ? AudioLines : type.startsWith("video/") ? Film : type.startsWith("image/") ? FileImage : Paperclip;
  return <Icon aria-hidden="true" />;
}

function ChipBody({ thumbnail, type, name, detail, announce = false }: { announce?: boolean; thumbnail: string | null; type: string; name: string; detail: string }) {
  return <><span className="agent-upload-thumb">{thumbnail ? <img src={thumbnail} loading="lazy" alt="" /> : <FileIcon type={type} />}</span>
    <span className="agent-upload-caption"><strong>{name}</strong><small role={announce ? "status" : undefined}>{detail}</small></span></>;
}

function RemoveUpload({ name, onRemove, cancel = false }: { name: string; onRemove: () => void; cancel?: boolean }) {
  const label = `${cancel ? "取消上传" : "移除"} ${name}`;
  return <button type="button" className="agent-upload-remove" aria-label={label} title={label} onClick={onRemove}><X /></button>;
}

function PendingChip({ job, onRemove }: { job: PendingUpload; onRemove: () => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  useEffect(() => {
    if (!job.file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(job.file);
    setThumbnail(url);
    return () => URL.revokeObjectURL(url);
  }, [job.file]);
  const sending = job.phase === "uploading" || job.phase === "queued";
  const detail = job.phase === "failed" ? job.error! : job.phase === "selected" ? formatBytes(job.file.size)
    : job.phase === "queued" ? "等待上传" : job.progress === 1 ? "已传输，正在检查素材"
    : job.progress === null ? "正在上传" : `正在上传 ${Math.floor(job.progress * 100)}%`;
  return <li data-upload-state={job.phase}><div className="agent-upload-chip">
    <ChipBody name={job.file.name} type={job.file.type} thumbnail={thumbnail} detail={detail} announce={job.phase === "failed" || job.progress === 1} />
    <RemoveUpload name={job.file.name} cancel={sending} onRemove={onRemove} /></div>
    {job.phase === "uploading" && job.progress !== 1 ? <progress value={job.progress ?? undefined} max={1} aria-label={`${job.file.name} 上传进度`} /> : null}
  </li>;
}

export function UploadChips({ attachments = [], pending = [], onOpen, onRemove, onCancel, onConfirm }: {
  attachments?: UploadAttachment[] | undefined; pending?: PendingUpload[]; onOpen?: (id: string, revision: string) => void;
  onRemove?: (attachment: UploadAttachment) => void; onCancel?: (id: string) => void; onConfirm?: () => void;
}) {
  const busy = pending.some(job => job.phase === "uploading" || job.phase === "queued");
  return <div className="agent-uploads">
    <ul aria-label={onConfirm ? "待发送附件" : "消息附件"}>{attachments.map(attachment => {
      const { source, facts, mimeType, blobId, durationMs } = attachment;
      const thumb = facts.firstFrame ? blobUrl(facts.firstFrame.blobId) : mimeType.startsWith("image/") ? blobUrl(blobId) : null;
      const detail = [facts.width && facts.height ? `${facts.width}×${facts.height}` : null,
        durationMs === null ? null : durationMs < 60000 ? `${durationMs / 1000} 秒` : mediaDuration(durationMs), formatBytes(facts.sizeBytes)].filter(Boolean).join(" · ");
      const body = <ChipBody type={mimeType} thumbnail={thumb} name={facts.fileName} detail={detail} />;
      return <li key={source.revisionId} data-upload-state="ready"><div className="agent-upload-chip">
        {onOpen ? <button className="agent-upload-open" type="button" aria-label={`查看附件 ${facts.fileName}`}
          onClick={() => onOpen(source.artifactId, source.revisionId)}>{body}</button> : body}
        {onRemove ? <RemoveUpload name={facts.fileName} onRemove={() => onRemove(attachment)} /> : null}
      </div></li>;
    })}{pending.map(job => <PendingChip key={job.id} job={job} onRemove={() => onCancel!(job.id)} />)}</ul>
    {onConfirm && pending.length && !busy ? <button type="button" className="agent-upload-consent" onClick={onConfirm}>
      确认拥有或获准使用，上传{pending.length > 1 ? ` ${pending.length} 个文件` : ""}
    </button> : null}
  </div>;
}
