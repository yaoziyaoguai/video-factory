import {
  Database,
  ChevronDown,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  StudioAssetMediaKind,
  StudioAssetOrigin,
  StudioAssetReuseStatus,
  StudioIndexedAsset,
  StudioIndexedAssetUsage,
  StudioResourceManifest,
  StudioRunSummary,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { beijingDateTime, creatorFacingTechnicalText, providerLabel } from "../presentation.js";
import { statusLabel } from "../components/StatusBadge.js";
import { unsplashPublicUrl } from "../components/UnsplashAttribution.js";
import { hasStockAttribution, StockAttribution } from "../components/StockAttribution.js";

type AssetFilter = "all" | StudioAssetMediaKind | "reusable" | "needs_review";
type AssetCollection = "creative" | "records";

export function AssetsPage() {
  const [manifest, setManifest] = useState<StudioResourceManifest>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [origin, setOrigin] = useState<"all" | StudioAssetOrigin>("all");
  const [provider, setProvider] = useState("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"work" | "asset">("work");
  const [collection, setCollection] = useState<AssetCollection>("creative");
  const [runs, setRuns] = useState<StudioRunSummary[]>([]);
  const [expandedWorkKeys, setExpandedWorkKeys] = useState<Set<string>>(new Set());
  // 主动预览协调：同一时间最多一个 video/audio 在播；开始新播放时暂停上一个，
  // 不重置它的 currentTime；切筛选/视图或离开页面时停掉旧播放（UX-08）。
  const playingMediaRef = useRef<HTMLMediaElement | null>(null);
  const handleMediaPlay = useCallback((element: HTMLMediaElement) => {
    if (playingMediaRef.current && playingMediaRef.current !== element) playingMediaRef.current.pause();
    playingMediaRef.current = element;
  }, []);
  const stopPlayingMedia = useCallback(() => {
    if (playingMediaRef.current) {
      playingMediaRef.current.pause();
      playingMediaRef.current = null;
    }
  }, []);
  useEffect(() => { stopPlayingMedia(); }, [filter, origin, provider, query, view, collection, stopPlayingMedia]);
  useEffect(() => () => stopPlayingMedia(), [stopPlayingMedia]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [manifestResult, runsResult] = await Promise.allSettled([studioApi.resourceManifest(), studioApi.runs()]);
      if (manifestResult.status === "rejected") throw manifestResult.reason;
      setManifest(manifestResult.value);
      setRuns(runsResult.status === "fulfilled" ? runsResult.value : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "素材库暂时无法读取。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const collectionAssets = useMemo(() => (manifest?.assetIndex.assets ?? []).filter((asset) => (
    collection === "creative" ? isCreativeAsset(asset) : !isCreativeAsset(asset)
  )), [collection, manifest?.assetIndex.assets]);

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return collectionAssets.filter((asset) => {
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
  }, [collectionAssets, filter, origin, provider, query]);

  const originOptions = [...new Set(collectionAssets.map((asset) => asset.origin))];
  const providerOptions = providerFilterOptions(collectionAssets);
  const hasFilters = filter !== "all" || origin !== "all" || provider !== "all" || Boolean(query.trim());
  const clearFilters = () => {
    setFilter("all");
    setOrigin("all");
    setProvider("all");
    setQuery("");
  };
  const workGroups = useMemo(() => groupAssetsByWork(assets, runs), [assets, runs]);
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  useEffect(() => {
    setExpandedWorkKeys((current) => {
      const visible = new Set(workGroups.map((group) => group.key));
      const retained = new Set([...current].filter((key) => visible.has(key)));
      if (retained.size === 0 && workGroups[0]) retained.add(workGroups[0].key);
      return retained;
    });
  }, [workGroups]);
  const collectionStats = useMemo(() => ({
    reusable: collectionAssets.filter((asset) => asset.reuseStatus === "ready").length,
    duplicateUses: collectionAssets.reduce((count, asset) => count + Math.max(0, asset.useCount - 1), 0),
    needsReview: collectionAssets.filter((asset) => asset.reuseStatus === "review_required").length,
    documents: collectionAssets.filter((asset) => asset.mediaKind === "document").length,
    finalRenders: collectionAssets.filter((asset) => asset.origin === "final_render").length,
  }), [collectionAssets]);
  const switchCollection = (next: AssetCollection) => {
    setCollection(next);
    clearFilters();
  };
  const visibleFilters = collection === "creative"
    ? FILTERS.filter((item) => item.id !== "document" && item.id !== "font" && item.id !== "other")
    : FILTERS.filter((item) => item.id !== "reusable" && item.id !== "needs_review");

  return (
    <main className="page asset-library-page">
      <header className="page-header asset-library-header">
        <div>
          <h1>素材库</h1>
          <p className="page-summary">{collection === "creative" ? "可再次用于创作的画面与声音，按内容去重并保留授权和入片记录。" : "最终成片、脚本与质检记录独立归档，不混入可复用素材。"}</p>
          <Link to="/resources#visual-providers">配置外部素材来源</Link>
        </div>
        <div className="asset-library-count"><strong>{collectionAssets.length}</strong><span>{collection === "creative" ? "项创作素材" : "项成片与记录"}</span></div>
      </header>

      {manifest ? <section className="asset-index-summary" aria-label="素材库概况">
        {collection === "creative" ? <>
          <div><Database aria-hidden="true" size={18} /><span>可复用（使用范围见授权记录）<strong>{collectionStats.reusable}</strong></span></div>
          <div><Layers3 aria-hidden="true" size={18} /><span>跨作品使用<strong>{collectionStats.duplicateUses}</strong></span></div>
          <div className={collectionStats.needsReview ? "needs-attention" : ""}><ShieldAlert aria-hidden="true" size={18} /><span><Link to="/resources#resource-manifest" aria-label={`去确认授权：授权待确认 ${collectionStats.needsReview} 项`}>授权待确认<strong>{collectionStats.needsReview}</strong></Link></span></div>
        </> : <>
          <div><FileText aria-hidden="true" size={18} /><span>制作文档<strong>{collectionStats.documents}</strong></span></div>
          <div><Film aria-hidden="true" size={18} /><span>最终成片<strong>{collectionStats.finalRenders}</strong></span></div>
          <div><Database aria-hidden="true" size={18} /><span>其他记录<strong>{Math.max(0, collectionAssets.length - collectionStats.documents - collectionStats.finalRenders)}</strong></span></div>
        </>}
      </section> : null}
      {manifest?.truncatedItemCount ? <p className="resource-note">页面只展开最近 500 条明细；搜索、筛选和素材统计仍覆盖全部 {manifest.totalItems} 条记录。</p> : null}

      <section className="asset-library-controls" aria-label="素材筛选">
        <div className="asset-library-organizers">
          <div className="asset-library-sections" role="group" aria-label="档案类型">
            <button type="button" aria-pressed={collection === "creative"} onClick={() => switchCollection("creative")}>创作素材</button>
            <button type="button" aria-pressed={collection === "records"} onClick={() => switchCollection("records")}>成片与记录</button>
          </div>
          <div className="asset-library-view" role="group" aria-label="素材组织方式">
            <button type="button" aria-pressed={view === "work"} onClick={() => setView("work")}>按作品</button>
            <button type="button" aria-pressed={view === "asset"} onClick={() => setView("asset")}>按资产</button>
          </div>
        </div>
        <div className="asset-library-filters">
          {visibleFilters.map((item) => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{assetCount(collectionAssets, item.id)}</span></button>)}
        </div>
        <div className="asset-library-refiners">
          <label><span className="sr-only">素材来源类型</span><select value={origin} onChange={(event) => setOrigin(event.target.value as "all" | StudioAssetOrigin)}><option value="all">全部来源</option>{originOptions.map((item) => <option key={item} value={item}>{originLabel(item)}</option>)}</select></label>
          <label><span className="sr-only">素材提供方</span><select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">全部提供方</option>{providerOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label className="asset-library-search"><Search aria-hidden="true" size={16} /><span className="sr-only">搜索素材</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索画面、标签或作品" /></label>
        </div>
      </section>

      {error ? <div className="inline-error" role="alert">{error}<button className="button button-secondary" type="button" onClick={() => void load()}>重新读取</button></div> : null}
      {loading && !manifest ? <div className="asset-library-empty">正在建立素材索引...</div> : null}
      {!loading && manifest && assets.length === 0 ? <div className="asset-library-empty"><FolderOpen aria-hidden="true" size={28} /><strong>这个范围里还没有内容</strong><span>{hasFilters ? "可以清除筛选，查看完整素材库。" : "完成一次真实制作后，镜头和制作记录会自动归档到这里。"}</span>{hasFilters ? <button className="button button-secondary" type="button" onClick={clearFilters}>清除筛选</button> : null}</div> : null}

      {assets.length && view === "asset" ? <section className="asset-library-grid" aria-live="polite">
        {assets.map((asset) => <AssetCard onMediaPlay={handleMediaPlay} asset={asset} run={runsById.get(asset.usages.at(-1)?.runId ?? "")} key={asset.key} />)}
      </section> : null}
      {assets.length && view === "work" ? <section className="asset-work-groups" aria-live="polite">
        {workGroups.map((group, index) => {
          const expanded = expandedWorkKeys.has(group.key);
          return <section className={expanded ? "asset-work-group is-expanded" : "asset-work-group"} key={group.key} aria-labelledby={`asset-work-${group.key}`}>
          <header><button type="button" className="asset-work-toggle" aria-expanded={expanded} aria-controls={`asset-work-items-${group.key}`} onClick={() => setExpandedWorkKeys((current) => {
            const next = new Set(current);
            if (next.has(group.key)) next.delete(group.key); else next.add(group.key);
            return next;
          })}><ChevronDown aria-hidden="true" size={18} /><div><small>{index === 0 ? "最近制作" : "历史制作"} · {group.items.length} 项素材</small><h2 id={`asset-work-${group.key}`}>{group.runTitle}</h2></div></button>{group.runId ? <Link to={`/projects/${group.runId}`}>打开制作</Link> : null}</header>
          {expanded ? <div id={`asset-work-items-${group.key}`} className="asset-library-grid">{group.items.map(({ asset, usage, workUsages }) => <AssetCard onMediaPlay={handleMediaPlay} asset={asset} usage={usage} workUsages={workUsages} run={runsById.get(group.runId ?? "")} grouped key={`${asset.key}:${usage?.itemId ?? "unassigned"}`} />)}</div> : null}
          </section>;
        })}
      </section> : null}
    </main>
  );
}

function groupAssetsByWork(assets: StudioIndexedAsset[], runs: StudioRunSummary[]): Array<{ key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage; workUsages?: StudioIndexedAssetUsage[] }> }> {
  const groups = new Map<string, { key: string; runId?: string; runTitle: string; items: Array<{ asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage; workUsages?: StudioIndexedAssetUsage[] }> }>();
  for (const asset of assets) {
    if (!asset.usages.length) {
      const group = groups.get("unassigned") ?? { key: "unassigned", runTitle: "未归属项目", items: [] };
      group.items.push({ asset });
      groups.set("unassigned", group);
    }
    // 同一资产在同一作品里可能有多条 usage（如同字节的旧/新声音记录）：卡片仍然
    // 一张，但完整保留本作品全部 usage 供版本徽标聚合，不能只留第一条（CR2/AP2a）。
    const usagesByRun = new Map<string, StudioIndexedAssetUsage[]>();
    for (const usage of asset.usages) {
      const list = usagesByRun.get(usage.runId) ?? [];
      list.push(usage);
      usagesByRun.set(usage.runId, list);
    }
    for (const [runId, runUsages] of usagesByRun) {
      const group = groups.get(runId) ?? { key: runId, runId, runTitle: runUsages[0]!.runTitle, items: [] };
      const usage = runUsages[0];
      group.items.push({ asset, ...(usage ? { usage } : {}), workUsages: runUsages });
      groups.set(runId, group);
    }
  }
  const runOrder = new Map(runs.map((run, index) => [run.id, index]));
  return [...groups.values()].sort((left, right) => {
    if (!left.runId) return 1;
    if (!right.runId) return -1;
    return (runOrder.get(left.runId) ?? Number.MAX_SAFE_INTEGER) - (runOrder.get(right.runId) ?? Number.MAX_SAFE_INTEGER);
  });
}

function AssetCard({ asset, usage, run, grouped = false, workUsages, onMediaPlay }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined; run?: StudioRunSummary | undefined; grouped?: boolean; workUsages?: StudioIndexedAssetUsage[] | undefined; onMediaPlay?: (element: HTMLMediaElement) => void }) {
  const resolvedUsage = usage ?? asset.usages.at(-1);
  const identity = assetUsageIdentity(asset, resolvedUsage, grouped);
  const metadata = assetMetadata(asset, run);
  const creator = creatorFacingTechnicalText(asset.creator);
  const visibleTags = asset.tags.filter((tag) => tag !== "studio-owner" && tag !== asset.creator);
  const isAudio = asset.mediaKind === "audio";
  const distinctWorks = isAudio ? new Set(asset.usages.map((item) => item.runId)).size : 0;
  // 徽标范围（CR2/AP2a/AP2b）：按作品视图聚合本作品该资产全部 usage；按资产视图单作品
  // 聚合全部 usage；多作品不输出无作品限定的 current，改为中性的按作品分别查看。
  const voiceBadge = isAudio
    ? !grouped && distinctWorks > 1
      ? { label: `用于 ${distinctWorks} 个作品，版本状态分别查看`, state: "unverified" as const }
      : voiceVersionBadge(grouped ? (workUsages ?? (resolvedUsage ? [resolvedUsage] : [])) : asset.usages)
    : undefined;
  const voiceWorks = isAudio && !grouped ? distinctWorks : 0;
  // 详情的声音版本归属按同样范围列明：按作品只列本作品；缺投影 usage 如实标未核实。
  const voiceDetailUsages = grouped ? (workUsages ?? (resolvedUsage ? [resolvedUsage] : [])) : asset.usages;
  return <article className="asset-card">
    <AssetPreview asset={asset} usage={resolvedUsage} identity={identity} {...(onMediaPlay ? { onMediaPlay } : {})} />
    <div className="asset-card-copy">
      <header><span>{originLabel(asset.origin)} · {mediaKindLabel(asset.mediaKind)}</span><b className={`reuse-${asset.reuseStatus}`}>{reuseStatusLabel(asset.reuseStatus)}</b></header>
      <h3>{assetTitle(asset, resolvedUsage)}</h3>
      {voiceBadge ? <p className="asset-voice-version" data-voice-state={voiceBadge.state}>{voiceBadge.label}{voiceBadge.operation ? ` · ${voiceBadge.operation}` : ""}{voiceBadge.time ? ` · ${voiceBadge.time}` : ""}</p> : null}
      <p className="asset-provider">{hasStockAttribution(resolvedUsage?.providerId ?? asset.providerId)
        ? <StockAttribution provider={resolvedUsage?.providerId ?? asset.providerId} creator={resolvedUsage?.creator ?? creator} creatorUrl={resolvedUsage?.creatorUrl ?? asset.creatorUrl} licenseNote={resolvedUsage?.licenseNote ?? asset.licenseNote} />
        : <>{providerLabel(asset.providerId) ?? "其他制作服务"}{creator ? ` · ${creator}` : ""}</>}</p>
      {metadata.length || visibleTags.length || (isAudio && voiceDetailUsages.length) ? <details className="asset-card-details">
        <summary>规格与标签<ChevronDown aria-hidden="true" size={14} /></summary>
        {metadata.length ? <ul className="asset-metadata" aria-label="素材规格">{metadata.map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {isAudio && voiceDetailUsages.length ? <ul className="asset-metadata" aria-label="声音版本归属">
          {voiceDetailUsages.map((item) => <li key={`${item.runId}:${item.itemId}`}>
            {`${item.runTitle} · ${item.voiceVersionInfo ? voiceVersionBadge([item]).label : "版本归属未核实"}`}
            {item.voiceVersionInfo ? item.voiceVersionInfo.versions.map((version) => <span key={version.versionId} className="asset-voice-version-id" title={version.versionId}>{`版本 ${version.versionId.slice(0, 8)}…`}</span>) : null}
          </li>)}
        </ul> : null}
        {visibleTags.length ? <div className="asset-tags">{visibleTags.slice(0, 5).map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
      </details> : null}
      <footer>
        <span>{voiceWorks > 1 ? `用于 ${voiceWorks} 个作品，展开看版本` : grouped ? identity : asset.useCount > 1 ? `已用于 ${asset.useCount} 个镜头` : resolvedUsage?.scenePosition ? `镜头 ${resolvedUsage.scenePosition}` : resolvedUsage ? identity : "未归属"}</span>
        <div>{asset.reuseStatus === "review_required" ? <Link to="/resources#resource-manifest" aria-label={`去确认授权：${assetTitle(asset, resolvedUsage)}`}>去确认授权</Link> : null}{resolvedUsage ? <Link to={`/projects/${resolvedUsage.runId}`} aria-label={`查看作品：${assetTitle(asset, resolvedUsage)}`}>查看作品</Link> : null}{asset.sourceUrl ? <a href={asset.sourceUrl} target="_blank" rel="noreferrer" aria-label={`查看素材原始来源：${assetTitle(asset, resolvedUsage)}（新窗口）`}><ExternalLink aria-hidden="true" size={14} /></a> : null}</div>
      </footer>
    </div>
  </article>;
}

/**
 * CLOUD-10/P4.2＋CR2：声音版本的可区分信息。徽标聚合传入范围内全部 usage 的版本事实，
 * 按完整 versionId 去重，不按数组顺序或时间挑一条：有效版=当前、有效版失效=已失效、
 * 其余绑定=历史；范围内没有投影信息=归属未核实。操作类型只在全部 usage 同一操作时
 * 展示（多操作并存时不挑一个冒充）；时间取可信绑定中最新 createdAt，缺失不显示。
 * 当前声音版本只说明声音版本归属，不等于已入当前成片或通过人工终审。
 */
function voiceVersionBadge(usages: StudioIndexedAssetUsage[]): { label: string; state: "current" | "historical" | "stale" | "unverified"; operation?: string | undefined; time?: string | undefined } {
  const infos = usages
    .map((usage) => usage.voiceVersionInfo)
    .filter((info): info is NonNullable<StudioIndexedAssetUsage["voiceVersionInfo"]> => Boolean(info));
  if (!infos.length) return { label: "版本归属未核实", state: "unverified" };
  const versionsById = new Map<string, NonNullable<StudioIndexedAssetUsage["voiceVersionInfo"]>["versions"][number]>();
  for (const info of infos) {
    for (const version of info.versions) {
      if (!versionsById.has(version.versionId)) versionsById.set(version.versionId, version);
    }
  }
  const versions = [...versionsById.values()];
  if (!versions.length) return { label: "版本归属未核实", state: "unverified" };
  const operations = new Set(infos.map((info) => info.operation));
  const operation = operations.size === 1 ? voiceOperationLabel([...operations][0]!) : undefined;
  const latest = versions.reduce((newest, version) => !newest || (version.createdAt ?? "") > (newest.createdAt ?? "") ? version : newest, versions[0]!);
  const time = latest.createdAt ? `${beijingDateTime(latest.createdAt)}（北京时间）` : undefined;
  if (versions.some((version) => version.state === "current")) {
    const historical = versions.filter((version) => version.state !== "current").length;
    return { label: historical > 0 ? `当前声音版本，另有 ${historical} 个历史版本` : "当前声音版本", state: "current", operation, time };
  }
  if (versions.some((version) => version.state === "stale")) return { label: "已失效的声音版本", state: "stale", operation, time };
  return { label: "历史声音版本", state: "historical", operation, time };
}

function voiceOperationLabel(operation: NonNullable<StudioIndexedAssetUsage["voiceVersionInfo"]>["operation"]): string {
  return ({
    synthesis: "配音生成",
    relayout: "配音时间调整",
    subtitle_recovery: "字幕同步恢复",
    unknown: "来源操作未识别",
  })[operation];
}

function AssetPreview({ asset, usage = asset.usages.at(-1), identity, onMediaPlay }: { asset: StudioIndexedAsset; usage?: StudioIndexedAssetUsage | undefined; identity: string; onMediaPlay?: (element: HTMLMediaElement) => void }) {
  const isUnsplash = (usage?.providerId ?? asset.providerId) === "unsplash-stock-v1";
  const imageUrl = isUnsplash
    ? unsplashPublicUrl(usage?.previewUrl ?? asset.previewUrl, "images.unsplash.com")
    : asset.contentUrl;
  if (asset.contentUrl && asset.mediaKind === "video") return <div className="asset-card-preview"><video aria-label={`${assetTitle(asset, usage)} 预览`} src={`${asset.contentUrl}#t=0.1`} muted controls playsInline preload="metadata" onPlay={(event) => onMediaPlay?.(event.currentTarget)} /><span className="asset-card-identity">{identity}</span></div>;
  if (imageUrl && asset.mediaKind === "image") return <div className="asset-card-preview"><img src={imageUrl} alt={`${assetTitle(asset, usage)} 素材`} loading="lazy" /><span className="asset-card-identity">{identity}</span></div>;
  if (asset.contentUrl && asset.mediaKind === "audio") return <div className="asset-card-preview is-audio"><Music2 aria-hidden="true" size={28} /><audio aria-label={`${assetTitle(asset, usage)} 试听`} src={asset.contentUrl} controls preload="none" onPlay={(event) => onMediaPlay?.(event.currentTarget)} /><span className="asset-card-identity">{identity}</span></div>;
  const Icon = asset.mediaKind === "video" ? Film : asset.mediaKind === "image" ? ImageIcon : asset.mediaKind === "audio" ? Music2 : asset.mediaKind === "document" ? FileText : Database;
  return <div className={`asset-card-preview is-${asset.mediaKind}`}><Icon aria-hidden="true" size={28} /><span>{mediaKindLabel(asset.mediaKind)}</span><span className="asset-card-identity">{identity}</span></div>;
}

function assetUsageIdentity(asset: StudioIndexedAsset, usage: StudioIndexedAssetUsage | undefined, grouped: boolean): string {
  if (usage) {
    const related = grouped ? asset.usages.filter((item) => item.runId === usage.runId) : [usage];
    const positions = [...new Set(related.flatMap((item) => item.scenePosition ? [item.scenePosition] : []))].sort((left, right) => left - right);
    if (positions.length) return `镜头 ${positions.join("、")}`;
  }
  return genericAssetIdentity(asset.mediaKind);
}

function genericAssetIdentity(kind: StudioAssetMediaKind): string {
  return ({
    video: "视频素材",
    image: "图片素材",
    audio: "声音素材",
    document: "制作文档",
    font: "字体资源",
    other: "制作资源",
  })[kind];
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

function assetCount(assets: StudioIndexedAsset[], filter: AssetFilter): number {
  if (filter === "all") return assets.length;
  if (filter === "reusable") return assets.filter((asset) => asset.reuseStatus === "ready").length;
  if (filter === "needs_review") return assets.filter((asset) => asset.reuseStatus === "review_required").length;
  return assets.filter((asset) => asset.mediaKind === filter).length;
}

function isCreativeAsset(asset: StudioIndexedAsset): boolean {
  return asset.origin !== "final_render" && ["video", "image", "audio"].includes(asset.mediaKind);
}

function providerFilterOptions(assets: StudioIndexedAsset[]): Array<{ id: string; label: string }> {
  const ids = [...new Set(assets.map((asset) => asset.providerId))].sort((left, right) => left.localeCompare(right));
  const baseLabels = ids.map((id) => providerLabel(id) ?? "其他制作服务");
  const counts = new Map<string, number>();
  for (const label of baseLabels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const candidates = ids.map((id, index) => {
    const baseLabel = baseLabels[index]!;
    if ((counts.get(baseLabel) ?? 0) < 2) return { id, baseLabel, label: baseLabel };
    const related = assets.filter((asset) => asset.providerId === id);
    const suffix = [...new Set(related.map(providerAssetSuffix))].join("与") || "制作资源";
    return { id, baseLabel, label: `${baseLabel} · ${suffix}` };
  });
  const candidateCounts = new Map<string, number>();
  for (const item of candidates) candidateCounts.set(item.label, (candidateCounts.get(item.label) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return candidates.map((item) => {
    if ((candidateCounts.get(item.label) ?? 0) < 2) return { id: item.id, label: item.label };
    const occurrence = (occurrences.get(item.label) ?? 0) + 1;
    occurrences.set(item.label, occurrence);
    return { id: item.id, label: `${item.label}（${occurrence}）` };
  });
}

function providerAssetSuffix(asset: StudioIndexedAsset): string {
  if (asset.mediaKind === "audio") return "声音";
  if (asset.mediaKind === "video") return asset.origin === "final_render" ? "成片" : "视频";
  if (asset.mediaKind === "image") return "图片";
  if (asset.mediaKind === "document") return "制作记录";
  if (asset.mediaKind === "font") return "字体";
  return "其他资源";
}

function assetTitle(asset: StudioIndexedAsset, usage = asset.usages.at(-1)): string {
  if (asset.origin === "final_render" || asset.origin === "production_document" || asset.mediaKind === "document") {
    return productionRecordTitle(asset);
  }
  if (asset.query) return asset.query;
  if (!usage) return mediaKindLabel(asset.mediaKind);
  return usage.scenePosition ? `${usage.runTitle} · 镜头 ${usage.scenePosition}` : usage.runTitle;
}

function productionRecordTitle(asset: StudioIndexedAsset): string {
  if (asset.kind === "render") return "最终成片";
  if (asset.kind === "script") return "脚本";
  if (asset.kind === "storyboard") return "导演方案";
  if (asset.kind === "asset_plan") return "画面方案";
  if (asset.kind === "generation_jobs") return "画面生成记录";
  if (asset.kind === "publish_package") return "发布包";
  if (asset.kind === "review_report") {
    if (asset.providerId.includes("technical-review")) return "技术质检报告";
    if (asset.providerId.includes("visual-review") || asset.providerId === "openai") return "视觉审片报告";
    return "审片报告";
  }
  return "制作记录";
}

function assetMetadata(asset: StudioIndexedAsset, run?: StudioRunSummary): string[] {
  return [
    asset.width && asset.height ? `${asset.width} × ${asset.height}` : undefined,
    asset.aspectRatio,
    asset.durationSeconds ? `${Math.round(asset.durationSeconds * 10) / 10} 秒` : undefined,
    asset.usages.some((item) => item.runId === run?.id && item.selectedInFinal) ? "已入片" : undefined,
    run ? `${formatRunDate(run.finishedAt ?? run.startedAt)} · ${statusLabel(run.status)}` : undefined,
  ].filter((item): item is string => Boolean(item));
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function mediaKindLabel(kind: StudioAssetMediaKind): string {
  return ({ video: "视频", image: "图片", audio: "声音", document: "制作文档", font: "字体", other: "其他" })[kind];
}

function originLabel(origin: StudioAssetOrigin): string {
  return ({ stock: "授权素材", ai_generated: "AI 生成", local_generated: "本地制作", creator_upload: "个人上传", final_render: "最终成片", voice_synthesis: "合成声音", production_document: "制作过程", system: "系统资源" })[origin];
}

function reuseStatusLabel(status: StudioAssetReuseStatus): string {
  return ({ ready: "可复用，使用范围见授权记录", review_required: "授权待确认", private: "仅当前项目可用", not_reusable: "仅作记录" })[status];
}
