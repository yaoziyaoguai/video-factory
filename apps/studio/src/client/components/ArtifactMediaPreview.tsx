import { useState, type SyntheticEvent } from "react";
import type { StudioArtifact } from "../../shared/api.js";
import { unsplashPublicUrl } from "./UnsplashAttribution.js";

/** 文件区与逐镜素材共用预览，失败只影响显示，不产生制作命令。 */
export function ArtifactMediaPreview({ artifact, label }: { artifact: StudioArtifact; label: string }) {
  const video = artifact.contentType?.startsWith("video/");
  const audio = artifact.contentType?.startsWith("audio/");
  const source = !video && !audio && artifact.providerId === "unsplash-stock-v1"
    ? unsplashPublicUrl(artifact.previewUrl, "images.unsplash.com") : artifact.contentUrl;
  const identity = `${artifact.id}:${source}`;
  const [failedIdentity, setFailedIdentity] = useState<string>();
  const failed = failedIdentity === identity;
  const onError = () => setFailedIdentity(identity);
  const onReady = () => setFailedIdentity(current => current === identity ? undefined : current);
  function onPlay(event: SyntheticEvent<HTMLMediaElement>) {
    const media = event.currentTarget;
    media.closest("main")?.querySelectorAll<HTMLMediaElement>("video, audio").forEach(other => {
      if (other !== media && !other.paused) other.pause();
    });
  }
  return <>
    {video ? <video aria-label={`${label} 画面预览`} src={source} controls playsInline preload="metadata" onError={onError} onLoadedData={onReady} onPlay={onPlay} />
      : audio ? <audio aria-label={`${label} 试听`} src={source} controls preload="none" onError={onError} onLoadedData={onReady} onPlay={onPlay} />
        : <img alt={`${label} 画面预览`} src={source} loading="lazy" onError={onError} onLoad={onReady} hidden={failed} />}
    {failed || !source ? <p className="media-preview-error" role="status">{label} 预览读取失败，原素材记录仍保留。</p> : null}
  </>;
}
