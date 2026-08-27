import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CircleMinus,
  Clapperboard,
  Film,
  ListChecks,
  RadioTower,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  StudioLocalCapability,
  StudioCreatorSettings,
  StudioProductionDefaults,
  StudioProductionRecipeId,
  StudioProvider,
  StudioPublishTarget,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSource,
  StudioVoiceDirection,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { VoiceStudio } from "../components/VoiceStudio.js";

const SERVICE_STATUS = { ready: "在线", degraded: "受限", stopped: "离线" } as const;
const DEFAULT_PRODUCTION_DEFAULTS: StudioProductionDefaults = {
  directorProfileId: "auto",
  reviewMode: "manual",
  platform: "douyin",
  durationSeconds: 24,
};

const RECIPE_OPTIONS: Array<{ id: StudioProductionRecipeId; label: string }> = [
  { id: "economy-daily", label: "经济日更" },
  { id: "free-stock", label: "全免费精搜" },
  { id: "keyshot-ai", label: "效果均衡" },
  { id: "cinematic-ai", label: "精品上限" },
];

export function ResourcesPage() {
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [trendSources, setTrendSources] = useState<StudioTrendSource[]>([]);
  const [services, setServices] = useState<StudioTrendService[]>([]);
  const [signals, setSignals] = useState<StudioTrendSignal[]>([]);
  const [capabilities, setCapabilities] = useState<StudioLocalCapability[]>([]);
  const [publishTargets, setPublishTargets] = useState<StudioPublishTarget[]>([]);
  const [providerLoading, setProviderLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [providerError, setProviderError] = useState<string>();
  const [trendError, setTrendError] = useState<string>();
  const [serviceError, setServiceError] = useState<string>();
  const [publishError, setPublishError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [settings, setSettings] = useState<StudioCreatorSettings>();
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string>();
  const [voiceDirection, setVoiceDirection] = useState<StudioVoiceDirection>({
    profileId: "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  });
  const [defaultRecipeId, setDefaultRecipeId] = useState<StudioProductionRecipeId>("economy-daily");
  const [productionDefaults, setProductionDefaults] = useState<StudioProductionDefaults>(DEFAULT_PRODUCTION_DEFAULTS);

  const load = useCallback(async () => {
    setProviderLoading(true);
    setTrendLoading(true);
    setProviderError(undefined);
    setTrendError(undefined);
    setServiceError(undefined);
    setPublishError(undefined);
    setSettingsError(undefined);
    const [providerResult, trendResult, serviceResult, signalResult, capabilityResult, settingsResult, publishResult] = await Promise.allSettled([
      studioApi.providers(),
      studioApi.trendSources(),
      studioApi.trendServices(),
      studioApi.trendSignals(undefined, 16),
      studioApi.localCapabilities(),
      studioApi.settings(),
      studioApi.publishTargets(),
    ]);
    if (providerResult.status === "fulfilled") setProviders(providerResult.value);
    else setProviderError(errorMessage(providerResult.reason));
    if (trendResult.status === "fulfilled") setTrendSources(trendResult.value);
    else setTrendError(errorMessage(trendResult.reason));
    if (serviceResult.status === "fulfilled") setServices(serviceResult.value);
    else setServiceError(errorMessage(serviceResult.reason));
    if (signalResult.status === "fulfilled") setSignals(signalResult.value);
    if (capabilityResult.status === "fulfilled") setCapabilities(capabilityResult.value);
    if (settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value);
      setVoiceDirection(settingsResult.value.voiceDirection);
      setDefaultRecipeId(settingsResult.value.defaultRecipeId);
      setProductionDefaults(settingsResult.value.productionDefaults ?? DEFAULT_PRODUCTION_DEFAULTS);
    } else {
      setSettings(undefined);
      setSettingsError(errorMessage(settingsResult.reason));
    }
    if (publishResult.status === "fulfilled") setPublishTargets(publishResult.value);
    else setPublishError(errorMessage(publishResult.reason));
    setProviderLoading(false);
    setTrendLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveDefaults(patch: Parameters<typeof studioApi.updateSettings>[0], successMessage: string) {
    setSettingsSaving(true);
    setSettingsNotice(undefined);
    try {
      const updated = await studioApi.updateSettings(patch);
      setSettings(updated);
      if (patch.voiceDirection) setVoiceDirection(updated.voiceDirection);
      if (patch.defaultRecipeId) setDefaultRecipeId(updated.defaultRecipeId);
      if (patch.productionDefaults) setProductionDefaults(updated.productionDefaults);
      setSettingsNotice(successMessage);
    } catch (caught) {
      setSettingsNotice(`保存失败：${errorMessage(caught)}`);
    } finally {
      setSettingsSaving(false);
    }
  }

  const visualProviders = useMemo(() => providers.filter((provider) => provider.capability === "asset.prepare"), [providers]);
  const foundationProviders = useMemo(() => providers.filter((provider) => provider.capability !== "asset.prepare" && provider.capability !== "voice.synthesize"), [providers]);
  const readyVisual = visualProviders.filter(isProductionReady).length;
  const readyServices = services.filter((service) => service.status === "ready").length;
  const voiceHasChanges = settings ? !sameVoiceDirection(settings.voiceDirection, voiceDirection) : false;
  const productionHasChanges = settings
    ? settings.defaultRecipeId !== defaultRecipeId || !sameProductionDefaults(settings.productionDefaults, productionDefaults)
    : false;
  const readyFoundation = foundationProviders.filter(isProductionReady).length;
  const usablePublishTargets = publishTargets.filter((target) => target.status === "ready" || target.status === "manual_only").length;

  return (
    <main className="page resources-page">
      <header className="page-header resources-header">
        <div>
          <p className="eyebrow">VideoFactory Control Room</p>
          <h1>总配置</h1>
          <p className="page-summary">为下一条视频确定默认创作方式，并检查热点、模型、声音、画面和发布出口是否真正可用。</p>
        </div>
        <button
          aria-label="刷新能力状态"
          className="icon-button"
          type="button"
          onClick={() => void load()}
          title="刷新能力状态"
        >
          <RefreshCw aria-hidden="true" size={17} />
        </button>
      </header>

      <section className="resource-masthead" aria-label="能力概览" data-tour="resource-overview">
        <div><span>热点服务</span><strong>{serviceError ? "—" : `${readyServices}/${services.length}`}</strong></div>
        <div><span>画面来源</span><strong>{providerError ? "—" : readyVisual}</strong></div>
        <div><span>生产岗位</span><strong>{providerError ? "—" : `${readyFoundation}/${foundationProviders.length}`}</strong></div>
        <div className="resource-budget"><UploadCloud aria-hidden="true" size={17} /><span>发布出口</span><strong>{publishError ? "—" : usablePublishTargets}</strong></div>
      </section>

      <nav className="configuration-index" aria-label="配置分区">
        <a href="#creation-defaults"><SlidersHorizontal aria-hidden="true" size={15} />创作默认</a>
        <a href="#trend-connections"><RadioTower aria-hidden="true" size={15} />热点信号</a>
        <a href="#voice-casting"><Sparkles aria-hidden="true" size={15} />声音演员</a>
        <a href="#visual-providers"><Film aria-hidden="true" size={15} />画面来源</a>
        <a href="#production-roles"><Clapperboard aria-hidden="true" size={15} />岗位模型</a>
        <a href="#publish-channels"><UploadCloud aria-hidden="true" size={15} />发布渠道</a>
      </nav>

      <section id="creation-defaults" className="resource-section configuration-defaults" data-tour="configuration-defaults">
        <ResourceHeading eyebrow="创作基线" title="新建制作默认值" meta="保存后自动带入下一条视频，创建时仍可单独调整" />
        {settingsError ? <ResourceError title="创作默认值读取失败" message={settingsError} retry={load} /> : !settings ? <div className="region-loading">正在读取创作默认值...</div> : <div className="configuration-sheet">
          <div className="configuration-intro">
            <Settings2 aria-hidden="true" size={22} />
            <div><strong>先定创作习惯，再开始生产</strong><p>默认使用人工终审和经济日更；模型只在节点需要时调用，付费镜头仍受制作配方约束。</p><small>运行底座 {capabilities.filter((item) => item.state === "ready").length}/{capabilities.length} 项就绪</small></div>
          </div>
          <div className="configuration-fields">
            <label className="field"><span>成本策略</span><select aria-label="默认成本策略" value={defaultRecipeId} onChange={(event) => setDefaultRecipeId(event.target.value as StudioProductionRecipeId)}>{RECIPE_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
            <label className="field"><span>导演角色</span><select aria-label="默认导演角色" value={productionDefaults.directorProfileId} onChange={(event) => setProductionDefaults((current) => ({ ...current, directorProfileId: event.target.value as StudioProductionDefaults["directorProfileId"] }))}>
              <option value="auto">自动选导演</option><option value="documentary-observer">纪实观察</option><option value="quiet-humanism">静观生活</option><option value="urban-poetic">都市诗意</option><option value="chromatic-storytelling">色彩叙事</option><option value="geometric-control">几何秩序</option><option value="suspense-staging">悬念调度</option>
            </select></label>
            <label className="field"><span>目标平台</span><select aria-label="默认目标平台" value={productionDefaults.platform} onChange={(event) => setProductionDefaults((current) => ({ ...current, platform: event.target.value as StudioProductionDefaults["platform"] }))}><option value="douyin">抖音</option><option value="xiaohongshu">小红书</option><option value="bilibili">哔哩哔哩</option></select></label>
            <label className="field"><span>默认时长</span><select aria-label="默认视频时长" value={String(productionDefaults.durationSeconds)} onChange={(event) => setProductionDefaults((current) => ({ ...current, durationSeconds: Number(event.target.value) as StudioProductionDefaults["durationSeconds"] }))}><option value="20">20 秒</option><option value="24">24 秒</option><option value="30">30 秒</option><option value="45">45 秒</option></select></label>
          </div>
          <div className="segmented-control configuration-review-mode" aria-label="终审方式"><span>人工终审</span><small>安全门禁，发布前不可跳过</small></div>
          <div className="configuration-save-row"><span>{productionHasChanges ? "有未保存的创作默认值" : "当前默认值已保存"}</span><button className="button button-primary" type="button" disabled={settingsSaving || !productionHasChanges} onClick={() => void saveDefaults({ defaultRecipeId, productionDefaults }, "创作默认值已保存，将从下一条新制作生效。")}><Save aria-hidden="true" size={16} />{productionHasChanges ? "保存创作默认" : "已保存"}</button></div>
        </div>}
      </section>
      {settingsNotice ? <p className="resource-settings-notice" role="status">{settingsNotice}</p> : null}

      <section id="trend-connections" className="resource-section signal-desk" data-tour="resource-trends">
        <ResourceHeading eyebrow="信号台" title="热点接入" meta="最近一次采集 · 来源可追溯" />
        {trendError ? <ResourceError title="热点源状态未知" message={trendError} retry={load} /> : null}
        {serviceError ? <ResourceError title="热点服务状态未知" message={serviceError} retry={load} /> : null}
        {!trendError ? (
          <div className="signal-desk-layout">
            <div className="service-ledger" aria-label="热点服务">
              {trendLoading ? <div className="region-loading">正在读取热点...</div> : services.map((service) => {
                const serviceUrl = browserServiceUrl(service.baseUrl);
                return <article key={service.id} className="service-row">
                  <span className={`service-light is-${service.status}`} />
                  <div><strong>{service.label}</strong><small>{serviceKind(service.kind)}</small></div>
                  <span>{service.itemCount === undefined ? SERVICE_STATUS[service.status] : `${service.itemCount} 条`}</span>
                  {serviceUrl
                    ? <a href={serviceUrl} target="_blank" rel="noreferrer" title={`打开 ${service.label}`}><ArrowUpRight aria-hidden="true" size={15} /></a>
                    : <span aria-label={`${service.label} 未配置地址`} />}
                </article>;
              })}
              {trendSources.filter((source) => source.status !== "ready").slice(0, 3).map((source) => (
                <article key={source.id} className="service-row is-muted">
                  <span className="service-light is-degraded" />
                  <div><strong>{source.label}</strong><small>{source.requirement ?? source.description}</small></div>
                  <span>{source.status === "needs_config" ? "需要配置" : "人工"}</span>
                </article>
              ))}
            </div>
            <ol className="live-signal-list" aria-label="已采集热点信号">
              {signals.length > 0 ? signals.slice(0, 12).map((signal) => (
                <li key={signal.id}>
                  <span>{String(signal.rank).padStart(2, "0")}</span>
                  <div><strong>{signal.title}</strong><small>{platformLabel(signal.platform)} · {sourceLabel(signal.sourceId)}</small></div>
                  {signal.heat ? <output>{compactNumber(signal.heat)}</output> : null}
                  {signal.url ? <a href={signal.url} target="_blank" rel="noreferrer" title="查看原始热点"><ArrowUpRight aria-hidden="true" size={14} /></a> : null}
                </li>
              )) : <li className="signal-empty"><RadioTower aria-hidden="true" size={18} /><span>等待第一批热点信号</span></li>}
            </ol>
          </div>
        ) : null}
      </section>

      <div id="voice-casting" className="resource-voice-studio" data-tour="resource-voice">
        <VoiceStudio title="声音演员表" sectionLabel="声音" value={voiceDirection} onChange={(next) => setVoiceDirection(next)} />
        <div className="resource-default-action">
          <div><strong>当前制作默认</strong><span>{voiceHasChanges ? "有未保存的声音调整" : "已保存"}</span></div>
          <button className="button button-secondary" type="button" disabled={settingsSaving || !voiceHasChanges} onClick={() => void saveDefaults({ voiceDirection }, "声音已设为新建制作的默认值。") }><Save aria-hidden="true" size={16} />{voiceHasChanges ? "设为制作默认" : "已是制作默认"}</button>
        </div>
      </div>

      <section id="visual-providers" className="resource-section visual-library" data-tour="resource-visual">
        <ResourceHeading eyebrow="画面资源" title="生成与素材模型" meta={`${readyVisual} 项可直接生产`} />
        {providerLoading ? <div className="region-loading">正在读取画面能力...</div> : providerError ? (
          <ResourceError title="画面能力状态未知" message={providerError} retry={load} />
        ) : <div className="provider-ledger">{visualProviders.map((provider) => <ProviderRow key={provider.id} provider={provider} isDefault={settings?.defaultAssetProviderId === provider.id} canSetDefault={provider.id !== "ai-shot-router-v1"} onSetDefault={(providerId) => void saveDefaults({ defaultAssetProviderId: providerId }, `${provider.label} 已设为默认画面能力。`)} />)}</div>}
      </section>

      <section id="production-roles" className="resource-section foundation-registry">
        <ResourceHeading eyebrow="岗位与模型" title="生产角色" meta="总编、编剧、导演、渲染、质检与发行编辑" />
        {providerLoading ? <div className="region-loading">正在读取生产底座...</div> : providerError ? null : (
          <div className="foundation-grid" aria-label="制作能力列表">
            {foundationProviders.map((provider) => <FoundationProvider key={provider.id} provider={provider} />)}
          </div>
        )}
      </section>

      <section id="publish-channels" className="resource-section publishing-registry" data-tour="configuration-publishing">
        <ResourceHeading eyebrow="交付出口" title="发布渠道" meta="未取得官方权限的平台只生成发布包，不会冒充自动发布" />
        {publishError ? <ResourceError title="发布渠道状态未知" message={publishError} retry={load} /> : (
          <div className="publishing-ledger" aria-label="发布渠道列表">
            {publishTargets.map((target) => <PublishTargetRow key={target.id} target={target} />)}
          </div>
        )}
        <div className="compliance-baseline"><ShieldCheck aria-hidden="true" size={18} /><div><strong>不可关闭的发布门禁</strong><span>人工终审、素材授权、事实核验、AIGC 显式与隐式标识会在发送前再次检查。</span></div></div>
      </section>
    </main>
  );
}

function ResourceHeading({ eyebrow, title, meta }: { eyebrow: string; title: string; meta: string }) {
  return <div className="section-heading resource-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div><span>{meta}</span></div>;
}

function ResourceError({ title, message, retry }: { title: string; message: string; retry: () => Promise<void> }) {
  return <div className="page-error" role="alert"><AlertCircle aria-hidden="true" size={18} /><span><strong>{title}</strong>{message}</span><button className="icon-button" type="button" onClick={() => void retry()} title="重试"><RefreshCw aria-hidden="true" size={17} /></button></div>;
}

function ProviderRow({ provider, isDefault, canSetDefault, onSetDefault }: { provider: StudioProvider; isDefault: boolean; canSetDefault: boolean; onSetDefault: (providerId: string) => void }) {
  const ready = isProductionReady(provider);
  const Icon = provider.billing === "free" ? Film : Sparkles;
  return (
    <article className="provider-ledger-row">
      <span className="provider-ledger-icon"><Icon aria-hidden="true" size={18} /></span>
      <div><strong>{provider.label}</strong><small>{provider.description ?? provider.id}</small>{!ready && provider.requirement ? <small className="provider-requirement">{provider.requirement}</small> : null}</div>
      <span>{(provider.modes ?? []).slice(0, 3).join(" · ")}</span>
      <strong className={provider.billing === "metered" ? "is-metered" : ""}>{billingLabel(provider.billing)}</strong>
      <span className={ready ? "ledger-state is-ready" : "ledger-state"}>{ready ? "可用" : provider.status === "planned" ? "规划中" : "需要配置"}</span>
      {ready && canSetDefault ? <button className={isDefault ? "provider-default is-active" : "provider-default"} type="button" disabled={isDefault} onClick={() => onSetDefault(provider.id)}>{isDefault ? "制作默认" : "设为默认"}</button> : ready ? <span className="provider-default is-static">系统路由</span> : <span />}
      {provider.docsUrl ? <a href={provider.docsUrl} target="_blank" rel="noreferrer" title={`${provider.label} 文档`}><ArrowUpRight aria-hidden="true" size={15} /></a> : <span />}
    </article>
  );
}

function billingLabel(billing: StudioProvider["billing"]): string {
  if (billing === "metered") return "按量计费";
  if (billing === "subscription") return "订阅额度";
  return "免费";
}

function FoundationProvider({ provider }: { provider: StudioProvider }) {
  const ready = isProductionReady(provider);
  return <article className="foundation-provider"><span className={ready ? "foundation-state is-ready" : "foundation-state"}>{ready ? <Check aria-hidden="true" size={15} /> : <CircleMinus aria-hidden="true" size={15} />}</span><div><strong>{provider.label}</strong><span className="foundation-description">{provider.description ?? capabilityLabel(provider.capability)}</span></div><span>{capabilityLabel(provider.capability)}</span><small>{provider.kind === "test" ? "仅测试" : ready ? "可用" : "未配置"}</small></article>;
}

function PublishTargetRow({ target }: { target: StudioPublishTarget }) {
  const usable = target.status === "ready" || target.status === "manual_only";
  const status = target.status === "ready"
    ? "官方接口可用"
    : target.status === "manual_only"
      ? "导出后人工发布"
      : target.status === "needs_config"
        ? "需要授权"
        : "尚未开放";
  return <article className="publishing-ledger-row">
    <span className={usable ? "publishing-mark is-usable" : "publishing-mark"}><ListChecks aria-hidden="true" size={17} /></span>
    <div><strong>{target.label}</strong><small>{target.requirement ?? "发布能力已接入"}</small></div>
    <span>{target.mode === "official_api" ? "官方 API" : "发布包"}</span>
    <strong className={usable ? "is-usable" : ""}>{status}</strong>
    {target.docsUrl ? <a href={target.docsUrl} target="_blank" rel="noreferrer" title={`${target.label} 开放平台文档`}><ArrowUpRight aria-hidden="true" size={15} /></a> : <span />}
  </article>;
}

function capabilityLabel(capability: StudioProvider["capability"]): string {
  return ({
    "topic.intelligence": "选题判断",
    "script.draft": "脚本生成",
    "storyboard.plan": "视觉导演",
    "video.render": "视频渲染",
    "quality.review": "机器质检",
    "publish.copy": "发行文案",
  } as Partial<Record<StudioProvider["capability"], string>>)[capability] ?? "制作能力";
}

function isProductionReady(provider: StudioProvider): boolean {
  return provider.available && provider.kind !== "test";
}

function serviceKind(kind: StudioTrendService["kind"]): string {
  return kind === "collector" ? "采集与历史" : kind === "feed" ? "中文 RSS 路由" : "榜单接口";
}

function browserServiceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.hostname === "host.docker.internal" || url.hostname.startsWith("vf-")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function platformLabel(platform: string): string {
  return ({ douyin: "抖音", weibo: "微博", zhihu: "知乎", bilibili: "B 站" } as Record<string, string>)[platform] ?? platform;
}

function sourceLabel(source: StudioTrendSignal["sourceId"]): string {
  return source === "dailyhot" ? "DailyHot" : source === "newsnow" ? "NewsNow" : source;
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameVoiceDirection(left: StudioVoiceDirection, right: StudioVoiceDirection): boolean {
  return left.profileId === right.profileId
    && left.rate === right.rate
    && left.pauseScale === right.pauseScale
    && left.masteringPreset === right.masteringPreset;
}

function sameProductionDefaults(left: StudioProductionDefaults | undefined, right: StudioProductionDefaults): boolean {
  if (!left) return false;
  return left.directorProfileId === right.directorProfileId
    && left.reviewMode === right.reviewMode
    && left.platform === right.platform
    && left.durationSeconds === right.durationSeconds;
}
