import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, X } from "lucide-react";
import { agentApi, type ArtifactRevision, type LibraryVideo } from "./api.js";
import type { ContentSource, LibraryMaterial, LibraryProjectFile } from "../../shared/agent/generated/contracts.js";
import type { LibraryPick } from "./workspace-state.js";
import { MarkdownBody, MarkdownText } from "./markdown.js";
import { AudioSummaryView } from "./AudioSummaryView.js";

// 作品库（§6）：只收用户定稿的最终视频，条目身份是 video.revisionId；
// 列表只给缩略图/标题/定稿时间，详情给播放/下载、采用的文稿与方案、回到对话。
// 不放认可按钮、预算卡或技术字段；来源缺失就标“未记录”，不拿当前稿补齐。

// G4-2 带入对话：勾选的是定稿当时的留存素材/封存工程文件，只随下一条消息带入，不是采用清单。
const MATERIAL_KIND_LABEL: Record<LibraryMaterial["kind"], string> = { image: "图片", audio: "音频", video: "视频", script: "脚本", prompt: "Prompt", analysis: "分析", project: "工程" };

// §11.7 来源3/8/9：勾选构造与工程分组在库详情页和输入框选择弹层共用，保持同一接受键集合。
function libraryFileGroups(entry: LibraryVideo): { files: LibraryProjectFile[]; main: boolean }[] {
  return entry.projectFiles.reduce<{ files: LibraryProjectFile[]; main: boolean }[]>((groups, file) => {
    const last = groups.at(-1);
    if (last && last.files[0]!.project.revisionId === file.project.revisionId) last.files.push(file);
    else groups.push({ files: [file], main: file.project.revisionId === entry.project?.revisionId });
    return groups;
  }, []);
}

function buildLibraryPicks(entry: LibraryVideo, pickedKeys: string[]): LibraryPick[] {
  const fileGroups = libraryFileGroups(entry);
  return [
    ...entry.materials
      .filter(material => pickedKeys.includes(`m:${material.source.revisionId}`))
      .map(material => ({
        label: `${material.label}（${MATERIAL_KIND_LABEL[material.kind]}）`,
        selection: { sourceVideo: entry.video, source: { kind: "artifact_revision" as const, artifactId: material.source.artifactId, revisionId: material.source.revisionId } },
      })),
    ...entry.projectFiles
      .filter(file => pickedKeys.includes(`f:${file.project.revisionId}:${file.relativePath}`))
      .map(file => ({
        label: fileGroups.length > 1 ? `${file.relativePath}（${file.project.revisionId === entry.project?.revisionId ? "主工程" : "来源工程"}）` : file.relativePath,
        selection: { sourceVideo: entry.video, source: { kind: "project_file" as const, project: file.project, relativePath: file.relativePath } },
      })),
  ];
}

function formatFinalized(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function blobUrl(blobId: string): string {
  return `/api/agent/v1/blobs/${encodeURIComponent(blobId)}/content`;
}

interface LoadState { phase: "loading" | "ready" | "failed"; items: LibraryVideo[]; nextCursor: string | null }

export function WorkLibrary({ onBringIn, bringTarget }: { onBringIn: (picks: LibraryPick[]) => void; bringTarget: "current" | "new" }) {
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
  if (open) return <LibraryDetail entry={open} bringTarget={bringTarget} onBringIn={onBringIn} onBack={() => setOpenRevisionId(null)} />;

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

function LibraryDetail({ entry, bringTarget, onBringIn, onBack }: { entry: LibraryVideo; bringTarget: "current" | "new"; onBringIn: (picks: LibraryPick[]) => void; onBack: () => void }) {
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

  // G4-2：勾选键对齐服务端入口验证的接受集——素材按留存清单修订、工程文件按封存清单路径。
  // §11.7 来源3：工程文件按行所属工程勾选；多工程合成时同名 relativePath 各自独立。
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const togglePick = (key: string) => setPickedKeys(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
  const picks = buildLibraryPicks(entry, pickedKeys);

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
      {entry.materials.length || entry.projectFiles.length ? <section className="agent-library-select">
        <h4>带入对话的素材</h4>
        <p className="agent-stage-muted">勾选只随下一条消息带入对话，不是最终采用清单。</p>
        <LibraryPickLists entry={entry} pickedKeys={pickedKeys} onToggle={togglePick} />
      </section> : null}
    </div>
    <footer className="agent-preview-actions">
      <button type="button" className="agent-library-back" disabled={!picks.length} onClick={() => onBringIn(picks)}>{bringTarget === "current" ? "带入当前对话" : "带入新对话"}{picks.length ? `（${picks.length}）` : ""}</button>
      <button type="button" className="agent-library-back" onClick={backToConversation}>回到来源对话</button>
      {entry.originMessageId ? null : <span className="agent-stage-muted">这条定稿没有可定位的产出消息，将回到对话最新位置。</span>}
    </footer>
  </article>;
}

// 勾选清单：素材按留存修订、工程文件按封存路径，多工程时按来源分组；库详情与输入框选择弹层共用。
function LibraryPickLists({ entry, pickedKeys, onToggle }: { entry: LibraryVideo; pickedKeys: string[]; onToggle: (key: string) => void }) {
  const fileGroups = libraryFileGroups(entry);
  return <>
    {entry.materials.length ? <ul>
      {entry.materials.map(material => {
        const key = `m:${material.source.revisionId}`;
        return <li key={key}><label><input type="checkbox" checked={pickedKeys.includes(key)} onChange={() => onToggle(key)} />{material.label}<small>{MATERIAL_KIND_LABEL[material.kind]}</small></label></li>;
      })}
    </ul> : null}
    {fileGroups.length ? fileGroups.map((group, index) => <ul key={group.files[0]!.project.revisionId}>
      {fileGroups.length > 1 ? <li className="agent-library-project-group">{index === 0 && group.main ? "主工程" : `来源工程 ${index + 1}`}</li> : null}
      {group.files.map(file => {
        const key = `f:${file.project.revisionId}:${file.relativePath}`;
        return <li key={key}><label><input type="checkbox" checked={pickedKeys.includes(key)} onChange={() => onToggle(key)} />{file.relativePath}<small>{file.mimeType}</small></label></li>;
      })}
    </ul>) : null}
  </>;
}

// §11.7 来源8：输入框旁“从作品库选择”弹层——选视频→勾素材/制作文件→并入当前输入草稿；
// 取消不发送、不导航，正文与阅读位置不动。
export function LibraryPickerDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (picks: LibraryPick[]) => void }) {
  const [load, setLoad] = useState<LoadState>({ phase: "loading", items: [], nextCursor: null });
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);
  const [pickedKeys, setPickedKeys] = useState<string[]>([]);
  const dialog = useRef<HTMLDivElement>(null);
  const loadList = useCallback(async () => {
    setLoad({ phase: "loading", items: [], nextCursor: null });
    try {
      const page = await agentApi.listLibraryVideos();
      setLoad({ phase: "ready", items: page.items, nextCursor: page.nextCursor });
    } catch { setLoad({ phase: "failed", items: [], nextCursor: null }); }
  }, []);
  useEffect(() => { void loadList(); }, [loadList]);
  const loadMore = async () => {
    if (!load.nextCursor) return;
    try {
      const page = await agentApi.listLibraryVideos(load.nextCursor);
      setLoad(current => ({ phase: "ready", items: [...current.items, ...page.items], nextCursor: page.nextCursor }));
    } catch { /* 翻页失败保留当前列表，重试由用户再次触发。 */ }
  };
  const entry = load.items.find(item => item.video.revisionId === openRevisionId) ?? null;
  const picks = entry ? buildLibraryPicks(entry, pickedKeys) : [];
  const togglePick = (key: string) => setPickedKeys(current => current.includes(key) ? current.filter(item => item !== key) : [...current, key]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
    if (event.key !== "Tab") return;
    const focusables = dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled])');
    if (!focusables?.length) return;
    const first = focusables[0]!, last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="agent-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="agent-modal agent-library-picker" role="dialog" aria-modal="true" aria-labelledby="agent-library-picker-title" ref={dialog} onKeyDown={onKeyDown}>
      <header className="agent-modal-header">
        <div><h3 id="agent-library-picker-title">从作品库选择</h3><p>勾选只加入当前输入草稿，随下一条消息带入，不会自动发送</p></div>
        <button type="button" className="agent-icon-button" aria-label="关闭作品库选择" autoFocus onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {entry ? <div className="agent-library-picker-body">
        <button type="button" className="agent-text-link" onClick={() => { setOpenRevisionId(null); setPickedKeys([]); }}><ArrowLeft />换一个视频</button>
        <h4>{entry.title}</h4>
        {entry.materials.length || entry.projectFiles.length
          ? <div className="agent-library-select"><LibraryPickLists entry={entry} pickedKeys={pickedKeys} onToggle={togglePick} /></div>
          : <p className="agent-stage-muted">这条定稿没有留存的素材或制作文件。</p>}
      </div>
      : load.phase === "ready" ? <div className="agent-library-picker-body">
        {load.items.length ? <ul className="agent-library-picker-list">
          {load.items.map(item => <li key={item.video.revisionId}><button type="button" onClick={() => setOpenRevisionId(item.video.revisionId)}>
            <strong>{item.title}</strong><small>定稿于 {formatFinalized(item.finalizedAt)} · {item.materials.length} 项素材 · {item.projectFiles.length} 个制作文件</small>
          </button></li>)}
        </ul> : <p className="agent-stage-muted">还没有定稿的视频，暂时没有可带入的素材。</p>}
        {load.nextCursor ? <button type="button" className="agent-load-older" onClick={() => void loadMore()}>更早的定稿</button> : null}
      </div>
      : load.phase === "loading" ? <p className="agent-config-note">正在读取作品库…</p>
      : <div className="agent-config-note"><p>作品库读取失败。</p><button type="button" onClick={() => void loadList()}>重试读取</button></div>}
      <footer className="agent-modal-actions">
        <button type="button" className="agent-secondary-button" onClick={onClose}>取消</button>
        <button type="button" className="agent-primary-button" disabled={!picks.length} onClick={() => { onConfirm(picks); onClose(); }}>加入输入框{picks.length ? `（${picks.length}）` : ""}</button>
      </footer>
    </div>
  </div>;
}
