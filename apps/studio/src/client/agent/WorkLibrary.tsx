import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { agentApi, type ArtifactRevision, type LibraryVideo } from "./api.js";
import type { ContentSource } from "../../shared/agent/generated/contracts.js";
import { MarkdownBody, MarkdownText } from "./markdown.js";
import { AudioSummaryView } from "./AudioSummaryView.js";

// 作品库（§6）：只收用户定稿的最终视频，条目身份是 video.revisionId；
// 列表只给缩略图/标题/定稿时间，详情给播放/下载、采用的文稿与方案、回到对话。
// 不放认可按钮、预算卡或技术字段；来源缺失就标“未记录”，不拿当前稿补齐。

function formatFinalized(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function blobUrl(blobId: string): string {
  return `/api/agent/v1/blobs/${encodeURIComponent(blobId)}/content`;
}

interface LoadState { phase: "loading" | "ready" | "failed"; items: LibraryVideo[]; nextCursor: string | null }

export function WorkLibrary() {
  const [load, setLoad] = useState<LoadState>({ phase: "loading", items: [], nextCursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    agentApi.listLibraryVideos()
      .then(page => { if (!disposed) setLoad({ phase: "ready", items: page.items, nextCursor: page.nextCursor }); })
      .catch(() => { if (!disposed) setLoad({ phase: "failed", items: [], nextCursor: null }); });
    return () => { disposed = true; };
  }, []);

  const loadMore = async () => {
    if (!load.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await agentApi.listLibraryVideos(load.nextCursor);
      setLoad(current => ({ phase: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor }));
    } catch { /* 下一页读取失败保留当前列表，重试由用户再次触发。 */ }
    finally { setLoadingMore(false); }
  };

  const open = load.items.find(item => item.video.revisionId === openRevisionId) ?? null;
  if (open) return <LibraryDetail entry={open} onBack={() => setOpenRevisionId(null)} />;

  return <div className="agent-library">
    {load.phase === "loading" ? <p className="agent-stage-muted">正在读取作品库…</p> : null}
    {load.phase === "failed" ? <p className="agent-field-error" role="alert">作品库读取失败，请刷新页面重试。</p> : null}
    {load.phase === "ready" && !load.items.length
      ? <p className="agent-stage-muted">还没有定稿的视频。在对话里以某一版成片定稿后，它会出现在这里。</p> : null}
    {load.items.map(entry => <LibraryRow key={entry.video.revisionId} entry={entry} onOpen={() => setOpenRevisionId(entry.video.revisionId)} />)}
    {load.nextCursor ? <button type="button" className="agent-load-older" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "读取中…" : "更早的定稿"}</button> : null}
  </div>;
}

function LibraryRow({ entry, onOpen }: { entry: LibraryVideo; onOpen: () => void }) {
  const [blobId, setBlobId] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    agentApi.readRevision(entry.video.artifactId, entry.video.revisionId)
      .then(revision => { if (!disposed) setBlobId(revision.content.format === "media" ? revision.content.blobId : null); })
      .catch(() => { /* 缩略图读不到时仍保留标题行，详情页会给出错误与重试。 */ });
    return () => { disposed = true; };
  }, [entry.video.artifactId, entry.video.revisionId]);
  return <button type="button" className="agent-library-item" onClick={onOpen}>
    <span className="agent-library-thumb">{blobId ? <video preload="metadata" muted playsInline src={blobUrl(blobId)} aria-hidden /> : null}</span>
    <span className="agent-library-meta"><strong>{entry.title}</strong><small>定稿于 {formatFinalized(entry.finalizedAt)}</small></span>
  </button>;
}

function LibraryDetail({ entry, onBack }: { entry: LibraryVideo; onBack: () => void }) {
  const navigate = useNavigate();
  const [video, setVideo] = useState<{ revision: ArtifactRevision | null; failed: boolean }>({ revision: null, failed: false });
  const [plan, setPlan] = useState<{ revision: ArtifactRevision | null; state: "loading" | "ready" | "missing" | "failed" }>({ revision: null, state: "loading" });
  const [content, setContent] = useState<{ source: ContentSource | null; revision: ArtifactRevision | null; state: "loading" | "ready" | "missing" | "failed" }>({ source: null, revision: null, state: "loading" });
  const [planExpanded, setPlanExpanded] = useState(false);

  useEffect(() => {
    let disposed = false;
    setVideo({ revision: null, failed: false });
    agentApi.readRevision(entry.video.artifactId, entry.video.revisionId)
      .then(revision => { if (!disposed) setVideo({ revision, failed: false }); })
      .catch(() => { if (!disposed) setVideo({ revision: null, failed: true }); });
    return () => { disposed = true; };
  }, [entry.video.artifactId, entry.video.revisionId]);

  useEffect(() => {
    let disposed = false;
    if (!entry.plan) { setPlan({ revision: null, state: "missing" }); return; }
    setPlan({ revision: null, state: "loading" });
    agentApi.readRevision(entry.plan.artifactId, entry.plan.revisionId)
      .then(revision => { if (!disposed) setPlan({ revision, state: "ready" }); })
      .catch(() => { if (!disposed) setPlan({ revision: null, state: "failed" }); });
    return () => { disposed = true; };
  }, [entry.plan]);

  useEffect(() => {
    let disposed = false;
    if (!entry.content) { setContent({ source: null, revision: null, state: "missing" }); return; }
    if (entry.content.kind === "message_text") { setContent({ source: entry.content, revision: null, state: "ready" }); return; }
    setContent({ source: entry.content, revision: null, state: "loading" });
    agentApi.readRevision(entry.content.artifactId, entry.content.revisionId)
      .then(revision => { if (!disposed) setContent({ source: entry.content, revision, state: "ready" }); })
      .catch(() => { if (!disposed) setContent({ source: entry.content, revision: null, state: "failed" }); });
    return () => { disposed = true; };
  }, [entry.content]);

  const backToConversation = () => {
    navigate(`/agent/${encodeURIComponent(entry.conversationId)}${entry.originMessageId ? `?anchor=${encodeURIComponent(entry.originMessageId)}` : ""}`);
  };

  return <article className="agent-paper agent-library-detail">
    <header className="agent-preview-header">
      <h2>{entry.title}</h2>
      <button type="button" className="agent-text-link" onClick={onBack}><ArrowLeft />返回作品库</button>
    </header>
    <p className="agent-library-finalized">定稿于 {formatFinalized(entry.finalizedAt)}</p>
    <div className="agent-preview-body">
      {video.revision && video.revision.content.format === "media"
        ? <div className="agent-preview-media">
          <video controls preload="metadata" src={blobUrl(video.revision.content.blobId)} aria-label="定稿视频" />
          <a href={blobUrl(video.revision.content.blobId)} download>下载文件</a>
        </div>
        : video.failed ? <p className="agent-field-error" role="alert">这条定稿的视频读取失败，请刷新重试。</p>
          : <p className="agent-stage-muted">正在读取视频…</p>}
      {entry.audioSummary ? <AudioSummaryView summary={entry.audioSummary} title="定稿视频的声音" /> : null}
      <details className="agent-library-source" open={false}>
        <summary>采用的文稿{content.state === "missing" ? " · 未记录" : ""}</summary>
        {content.state === "ready" && content.source?.kind === "message_text"
          ? <div className="agent-library-text"><span className="agent-stage-muted">来自聊天原文</span><MarkdownText text={content.source.text} /></div>
          : content.state === "ready" && content.revision && content.revision.content.format === "markdown"
            ? <div className="agent-library-text"><MarkdownBody content={content.revision.content} /></div>
            : content.state === "failed" ? <p className="agent-field-error" role="alert">采用的文稿读取失败。</p>
              : content.state === "missing" ? <p className="agent-stage-muted">这条定稿没有记录采用的文稿。</p>
                : <p className="agent-stage-muted">正在读取…</p>}
      </details>
      <details className="agent-library-source" open={planExpanded} onToggle={event => setPlanExpanded(event.currentTarget.open)}>
        <summary>采用的画面与声音方案{plan.state === "missing" ? " · 未记录" : ""}</summary>
        {plan.state === "ready" && plan.revision && plan.revision.content.format === "markdown"
          ? <div className="agent-library-text"><MarkdownBody content={plan.revision.content} /></div>
          : plan.state === "failed" ? <p className="agent-field-error" role="alert">采用的方案读取失败。</p>
            : plan.state === "missing" ? <p className="agent-stage-muted">这条定稿没有记录采用的方案。</p>
              : <p className="agent-stage-muted">正在读取…</p>}
        {!entry.audioSummary ? entry.narrationText !== null ? <section className="agent-library-text">
          <h5>本次制作旁白</h5>
          <p style={{ whiteSpace: "pre-wrap" }}>{entry.narrationText}</p>
        </section> : <p className="agent-stage-muted">这次制作没有可核对的逐字旁白记录。</p> : null}
      </details>
    </div>
    <footer className="agent-preview-actions">
      <button type="button" className="agent-library-back" onClick={backToConversation}>回到对话</button>
      {entry.originMessageId ? null : <span className="agent-stage-muted">这条定稿没有可定位的产出消息，将回到对话最新位置。</span>}
    </footer>
  </article>;
}
