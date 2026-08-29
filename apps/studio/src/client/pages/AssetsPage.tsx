import { ExternalLink, FileText, Film, FolderOpen, Image, Music2, Search, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { StudioResourceManifest, StudioResourceManifestItem } from "../../shared/api.js";
import { studioApi } from "../api.js";
import { providerLabel } from "../presentation.js";

type AssetFilter = "all" | StudioResourceManifestItem["category"] | "needs_review";

export function AssetsPage() {
  const [manifest, setManifest] = useState<StudioResourceManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<AssetFilter>("visual");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setManifest(await studioApi.resourceManifest());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "素材库暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (manifest?.items ?? []).filter((item) => {
      const matchesFilter = filter === "all"
        || (filter === "needs_review" ? item.reviewStatus === "needs_review" : item.category === filter);
      if (!matchesFilter) return false;
      if (!normalized) return true;
      return `${item.runTitle} ${item.kind} ${item.providerId} ${item.creator ?? ""}`.toLocaleLowerCase("zh-CN").includes(normalized);
    });
  }, [filter, manifest?.items, query]);

  return (
    <main className="page asset-library-page">
      <header className="page-header asset-library-header">
        <div><p className="eyebrow">创作资产</p><h1>素材库</h1><p className="page-summary">查看真实进入过制作线的画面、声音与文档，并追溯所属作品和授权状态。</p></div>
        <div className="asset-library-count"><strong>{manifest?.totalItems ?? 0}</strong><span>项资产</span></div>
      </header>

      <section className="asset-library-controls" aria-label="素材筛选">
        <div className="asset-library-filters">
          {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{assetCount(manifest, item.id)}</span></button>)}
        </div>
        <label className="asset-library-search"><Search aria-hidden="true" size={16} /><span className="sr-only">搜索素材</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索作品或素材来源" /></label>
      </section>

      {error ? <div className="inline-error" role="alert">{error}<button className="button button-secondary" type="button" onClick={() => void load()}>重新读取</button></div> : null}
      {loading && !manifest ? <div className="asset-library-empty">正在整理跨项目素材...</div> : null}
      {!loading && manifest && items.length === 0 ? <div className="asset-library-empty"><FolderOpen aria-hidden="true" size={28} /><strong>这个筛选下还没有素材</strong><span>素材会在真实制作完成后自动归档到这里。</span></div> : null}

      {items.length ? <section className="asset-library-grid" aria-live="polite">
        {items.map((item) => <article className="asset-card" key={`${item.runId}:${item.id}`}>
          <AssetPreview item={item} />
          <div className="asset-card-copy">
            <header><span>{categoryLabel(item.category)}</span>{item.reviewStatus === "needs_review" ? <b><ShieldAlert aria-hidden="true" size={12} />待确认授权</b> : <b className="is-recorded">授权已记录</b>}</header>
            <h2>{item.runTitle}</h2>
            <p>{providerLabel(item.providerId) ?? item.providerId}</p>
            <footer>
              <Link to={`/projects/${item.runId}`}>查看所属作品</Link>
              {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">查看来源<ExternalLink aria-hidden="true" size={13} /></a> : null}
            </footer>
          </div>
        </article>)}
      </section> : null}
    </main>
  );
}

function AssetPreview({ item }: { item: StudioResourceManifestItem }) {
  if (item.contentUrl && item.contentType?.startsWith("video/")) return <div className="asset-card-preview"><video aria-label={`${item.runTitle} 预览`} src={`${item.contentUrl}#t=0.1`} muted playsInline preload="metadata" /></div>;
  if (item.contentUrl && item.contentType?.startsWith("image/")) return <div className="asset-card-preview"><img src={item.contentUrl} alt={`${item.runTitle} 素材`} loading="lazy" /></div>;
  const Icon = item.category === "visual" ? Image : item.category === "voice" ? Music2 : item.category === "document" ? FileText : Film;
  return <div className={`asset-card-preview is-${item.category}`}><Icon aria-hidden="true" size={27} /><span>{categoryLabel(item.category)}</span></div>;
}

const FILTERS: Array<{ id: AssetFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "visual", label: "画面" },
  { id: "voice", label: "声音" },
  { id: "document", label: "文档" },
  { id: "needs_review", label: "待确认授权" },
];

function assetCount(manifest: StudioResourceManifest | undefined, filter: AssetFilter): number {
  if (!manifest) return 0;
  if (filter === "all") return manifest.totalItems;
  if (filter === "needs_review") return manifest.needsReviewCount;
  return manifest.categories[filter];
}

function categoryLabel(category: StudioResourceManifestItem["category"]): string {
  return ({ visual: "画面", voice: "声音", document: "制作文档", font: "字体", other: "其他" })[category];
}
