import {
  Database,
  ExternalLink,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  Music2,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type {
  StudioAssetMediaKind,
  StudioAssetOrigin,
  StudioAssetReuseStatus,
  StudioIndexedAsset,
  StudioIndexedAssetUsage,
  StudioResourceManifest,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { providerLabel } from "../presentation.js";

type AssetFilter = "all" | StudioAssetMediaKind | "reusable" | "needs_review";

export function AssetsPage() {
  const [manifest, setManifest] = useState<StudioResourceManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [origin, setOrigin] = useState<"all" | StudioAssetOrigin>("all");
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"work" | "asset">("work");

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

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return (manifest?.assetIndex.assets ?? []).filter((asset) => {
      const matchesFilter = filter === "all"
        || (filter === "reusable" ? asset.reuseStatus === "ready"
          : filter === "needs_review" ? asset.reuseStatus === "review_required"
            : asset.mediaKind === filter);
      if (!matchesFilter || (origin !== "all" && asset.origin !== origin) || (provider !== "all" && asset.providerId !== provider)) return false;
      if (!normalized) return true;
      return [
        asset.query,
        asset.providerId,
        asset.creator,
        ...asset.tags,
        ...asset.usages.map((usage) => usage.runTitle),
        ...asset.usages.map((usage) => usage.providerId),
      ].filter(Boolean).join(" ").toLocaleLowerCase("zh-CN").includes(normalized);
    });
  }, [filter, manifest?.assetIndex.assets, origin, provider, query]);

  const originOptions = Object.keys(manifest?.assetIndex.facets.origins ?? {}) as StudioAssetOrigin[];
  const providerOptions = Object.keys(manifest?.assetIndex.facets.providers ?? {}).sort((left, right) => left.localeCompare(right));
  const hasFilters = filter !== "all" || origin !== "all" || provider !== "all" || Boolean(query.trim());
  const clearFilters = () => {
    setFilter("all");
    setOrigin("all");
    setProvider("all");
    setQuery("");
  };
  const workGroups = useMemo(() => groupAssetsByWork(assets), [assets]);

  return (
    <main className="page asset-library-page">
      <header className="page-header asset-library-header">
        <div>
          <p className="eyebrow">创作资产</p>
          <h1>素材档案</h1>
          <p className="page-summary">按内容去重归档，保留来源、授权状态和每一次入片记录。</p>
        </div>
        <div className="asset-library-count"><strong>{manifest?.assetIndex.totalAssets ?? 0}</strong><span>项独立资产</span></div>
      </header>

      {manifest ? <section className="asset-index-summary" aria-label="素材库概况">
        <div><Database aria-hidden="true" size={18} /><span>可直接复用<strong>{manifest.assetIndex.reusableCount}</strong></span></div>
        <div><Layers3 aria-hidden="true" size={18} /><span>跨作品使用<strong>{manifest.assetIndex.duplicateUses}</strong></span></div>
        <div className={manifest.assetIndex.needsReviewCount ? "needs-attention" : ""}><ShieldAlert aria-hidden="true" size={18} /><span>授权待确认<strong>{manifest.assetIndex.needsReviewCount}</strong></span></div>
      </section> : null}
      {manifest?.truncatedItemCount ? <p className="resource-note">明细列表只展示前 500 条；上方索引与筛选仍覆盖全部 {manifest.totalItems} 条素材记录。</p> : null}

      <section className="asset-library-controls" aria-label="素材筛选">
        <div className="asset-library-view" role="group" aria-label="素材组织方式">
          <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>按作品</button>
          <button type="button" aria-pressed={view === "asset"} onClick={() => setView("asset")}>按资产</button>
        </div>
        <div className="asset-library-filters">
          {FILTERS.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{assetCount(manifest, item.id)}</span></button>)}
        </div>
        <div className="asset-library-refiners">
          <label><span className="sr-only">素材来源类型</span><select value={origin} onChange={(event) => setOrigin(event.target.value as "all" | StudioAssetOrigin)}><option value="all">全部来源</option>{originOptions.map((item) => <option key={item} value={item}>{originLabel(item)}</option>)}</select></label>
          <label><span className="sr-only">素材提供方</span><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">全部提供方</option>{providerOptions.map((item) => <option key={item} value={item}>{providerLabel(item) ?? item}</option>)}</select></label>
          <label className="asset-library-search"><Search aria-hidden="true" size={16} /><span className="sr-only">搜索素材</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索画面、标签或作品" /></label>
        </div>
      </section>

      {error ? <div className="inline-error" role="alert">{error}<button className="button button-secondary" type="button" onClick={() => void load()}>重新读取</button></div> : null}
      {loading && !manifest ? <div className="asset-library-empty">正在建立素材索引...</div> : null}
      {!loading && manifest && assets.length === 0 ? <div className="asset-library-empty"><FolderOpen aria-hidden="true" size={28} /><strong>这个范围里还没有素材</strong><span>{hasFilters ? "可以清除筛选，查看完整素材档案。" : "完成一次真实制作后，镜头会自动归档到这里。"}</span>{hasFilters ? <button className="button button-secondary" type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : null}

      {assets.length && view === "asset" ? <section className="asset-library-grid" aria-live="polite">
        {assets.map((asset) => <AssetCard asset={asset} key={asset.key} />)}
      </section> : null}
      {assets.length && view === "work" ? <section className="asset-work-groups" aria-live="polite">
        {workGroups.map((group) => <section className="asset-work-group" key={group.key} aria-labelledby={`asset-work-${group.key}`}>
          <header><div><small>作品素材包 · {group.items.length} 项</small><h2 id={`asset-work-${group.key}`}>{group.runTitle}</h2></div>{group.runId ? <Link to={`/projects/${group.runId}`}>打开制作</Link> : null}</header>
          <div className="asset-library-grid">{group.items.map(({ asset, usage }) => <AssetCard asset={asset} usage={usage} grouped key={`${asset.key}:${usage?.itemId ?? "unassigned"}`} />)}</div>
        </section>)}
      </section> : null}
    </main>
  );
}

function groupAssetsByWork(assets: StudioIndexedAsset[]): Array<{ key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage }> }> {
  const groups = new Map<string, { key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage }> }>();
  for (const asset of assets) {
    if (!asset.usages.length) {
      const group = groups.get("unassigned") ?? { key: "unassigned", runTitle: "未归属项目", items: [] };
      group.items.push({ asset });
      groups.set("unassigned", group);
    }
    for (const usage of asset.usages) {
      const group = groups.get(usage.runId) ?? { key: usage.runId, runId: usage.runId, runTitle: usage.runTitle, items: [] };
      group.items.push({ asset, usage });
      groups.set(usage.runId, group);
    }
  }
  return [...groups.values()];
}

function AssetCard({ asset, usage, grouped = false }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined; grouped?: boolean }) {
  const resolvedUsage = usage ?? asset.usages.at(-1);
  const metadata = assetMetadata(asset);
  return <article className="asset-card">
    <AssetPreview asset={asset} usage={resolvedUsage} />
    <div className="asset-card-copy">
      <header><span>{originLabel(asset.origin)} · {mediaKindLabel(asset.mediaKind)}</span><b className={`reuse-${asset.reuseStatus}`}>{reuseStatusLabel(asset.reuseStatus)}</b></header>
      <h3>{assetTitle(asset, resolvedUsage)}</h3>
      <p className="asset-provider">{providerLabel(asset.providerId) ?? asset.providerId}{asset.creator ? ` · ${asset.creator}` : ""}</p>
      {metadata.length ? <ul className="asset-metadata" aria-label="素材规格">{metadata.map((item) => <li key={item}>{item}</li>)}</ul> : null}
      {asset.tags.length ? <div className="asset-tags">{asset.tags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      <footer>
        <span>{grouped ? (resolvedUsage?.scenePosition ? `镜头 ${resolvedUsage.scenePosition}` : resolvedUsage ? "已归档" : "未归属") : asset.useCount > 1 ? `已用于 ${asset.useCount} 个镜头` : resolvedUsage?.scenePosition ? `镜头 ${resolvedUsage.scenePosition}` : resolvedUsage ? "已归档" : "未归属"}</span>
        <div>{resolvedUsage ? <Link to={`/projects/${resolvedUsage.runId}`}>查看作品</Link> : null}{asset.sourceUrl ? <a href={asset.sourceUrl} target="_blank" rel="noreferrer" aria-label="查看素材原始来源"><ExternalLink aria-hidden="true" size={14} /></a> : null}</div>
      </footer>
    </div>
  </article>;
}

function AssetPreview({ asset, usage = asset.usages.at(-1) }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined }) {
  if (asset.contentUrl && asset.mediaKind === "video") return <div className="asset-card-preview"><video aria-label={`${assetTitle(asset, usage)} 预览`} src={`${asset.contentUrl}#t=0.1`} muted controls playsInline preload="metadata" /></div>;
  if (asset.contentUrl && asset.mediaKind === "image") return <div className="asset-card-preview"><img src={asset.contentUrl} alt={`${assetTitle(asset, usage)} 素材`} loading="lazy" /></div>;
  if (asset.contentUrl && asset.mediaKind === "audio") return <div className="asset-card-preview is-audio"><Music2 aria-hidden="true" size={28} /><audio aria-label={`${assetTitle(asset, usage)} 试听`} src={asset.contentUrl} controls preload="none" /></div>;
  const Icon = asset.mediaKind === "video" ? Film : asset.mediaKind === "image" ? ImageIcon : asset.mediaKind === "audio" ? Music2 : asset.mediaKind === "document" ? FileText : Database;
  return <div className={`asset-card-preview is-${asset.mediaKind}`}><Icon aria-hidden="true" size={28} /><span>{mediaKindLabel(asset.mediaKind)}</span></div>;
}

const FILTERS: Array<{ id: AssetFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "video", label: "视频" },
  { id: "image", label: "图片" },
  { id: "audio", label: "声音" },
  { id: "document", label: "文档" },
  { id: "reusable", label: "可复用" },
  { id: "needs_review", label: "待确认" },
];

function assetCount(manifest: StudioResourceManifest | undefined, filter: AssetFilter): number {
  if (!manifest) return 0;
  if (filter === "all") return manifest.assetIndex.totalAssets;
  if (filter === "reusable") return manifest.assetIndex.reusableCount;
  if (filter === "needs_review") return manifest.assetIndex.needsReviewCount;
  return manifest.assetIndex.facets.mediaKinds[filter] ?? 0;
}

function assetTitle(asset: StudioIndexedAsset, usage = asset.usages.at(-1)): string {
  if (asset.query) return asset.query;
  if (!usage) return mediaKindLabel(asset.mediaKind);
  return usage.scenePosition ? `${usage.runTitle} · 镜头 ${usage.scenePosition}` : usage.runTitle;
}

function assetMetadata(asset: StudioIndexedAsset): string[] {
  return [
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined,
    asset.aspectRatio,
    asset.durationSeconds ? `${Math.round(asset.durationSeconds * 10) / 10} 秒` : undefined,
    asset.usages.some((item) => item.selectedInFinal) ? "已入片" : undefined,
  ].filter((item): item is string => Boolean(item));
}

function mediaKindLabel(kind: StudioAssetMediaKind): string {
  return ({ video: "视频", image: "图片", audio: "声音", document: "制作文档", font: "字体", other: "其他" })[kind];
}

function originLabel(origin: StudioAssetOrigin): string {
  return ({ stock: "授权素材", ai_generated: "AI 生成", local_generated: "本地制作", creator_upload: "个人上传", final_render: "最终成片", voice_synthesis: "合成声音", production_document: "制作过程", system: "系统资源" })[origin];
}

function reuseStatusLabel(status: StudioAssetReuseStatus): string {
  return ({ ready: "可直接复用", review_required: "授权待确认", private: "仅当前项目", not_reusable: "仅作记录" })[status];
}
