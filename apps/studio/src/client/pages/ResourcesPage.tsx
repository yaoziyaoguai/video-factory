import {
  AlertCircle,
  ArrowUpRight,
  Check,
  CircleMinus,
  Film,
  Gauge,
  RadioTower,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  StudioLocalCapability,
  StudioCreatorSettings,
  StudioProvider,
  StudioTrendService,
  StudioTrendSignal,
  StudioTrendSource,
  StudioVoiceDirection,
} from "../../shared/api.js";
import { studioApi } from "../api.js";
import { VoiceStudio } from "../components/VoiceStudio.js";

const SERVICE_STATUS = { ready: "在线", degraded: "受限", stopped: "离线" } as const;

export function ResourcesPage() {
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [trendSources, setTrendSources] = useState<StudioTrendSource[]>([]);
  const [services, setServices] = useState<StudioTrendService[]>([]);
  const [signals, setSignals] = useState<StudioTrendSignal[]>([]);
  const [capabilities, setCapabilities] = useState<StudioLocalCapability[]>([]);
  const [providerLoading, setProviderLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [providerError, setProviderError] = useState<string>();
  const [trendError, setTrendError] = useState<string>();
  const [serviceError, setServiceError] = useState<string>();
  const [settings, setSettings] = useState<StudioCreatorSettings>();
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string>();
  const [voiceDirection, setVoiceDirection] = useState<StudioVoiceDirection>({
    profileId: "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  });

  const load = useCallback(async () => {
    setProviderLoading(true);
    setTrendLoading(true);
    setProviderError(undefined);
    setTrendError(undefined);
    setServiceError(undefined);
    const [providerResult, trendResult, serviceResult, signalResult, capabilityResult, settingsResult] = await Promise.allSettled([
      studioApi.providers(),
      studioApi.trendSources(),
      studioApi.trendServices(),
      studioApi.trendSignals(undefined, 16),
      studioApi.localCapabilities(),
      studioApi.settings(),
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
    }
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
      setVoiceDirection(updated.voiceDirection);
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

  return (
    <main className="page resources-page">
      <header className="page-header resources-header">
        <div>
          <p className="eyebrow">创作资源库</p>
          <h1>素材与模型</h1>
          <p className="page-summary">热点、声音、画面与制作服务，在这里形成一套有来源、有成本边界的创作语汇。</p>
        </div>
        <button className="icon-button" type="button" onClick={() => void load()} title="刷新能力状态">
          <RefreshCw aria-hidden="true" size={17} />
        </button>
      </header>

      <section className="resource-masthead" aria-label="能力概览" data-tour="resource-overview">
        <div><span>热点服务</span><strong>{serviceError ? "—" : `${readyServices}/${services.length}`}</strong></div>
        <div><span>画面来源</span><strong>{providerError ? "—" : readyVisual}</strong></div>
        <div><span>运行时</span><strong>{capabilities.filter((item) => item.state === "ready").length}</strong></div>
        <div className="resource-budget"><Gauge aria-hidden="true" size={17} /><span>经济日更估算</span><strong>¥0</strong></div>
      </section>

      <section className="resource-section signal-desk" data-tour="resource-trends">
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

      <div className="resource-voice-studio" data-tour="resource-voice">
        <VoiceStudio title="声音演员表" sectionLabel="声音" value={voiceDirection} onChange={(next) => setVoiceDirection(next)} />
        <div className="resource-default-action">
          <div><strong>当前制作默认</strong><span>{voiceHasChanges ? "有未保存的声音调整" : "已保存"}</span></div>
          <button className="button button-secondary" type="button" disabled={settingsSaving || !voiceHasChanges} onClick={() => void saveDefaults({ voiceDirection }, "声音已设为新建制作的默认值。") }><Save aria-hidden="true" size={16} />{voiceHasChanges ? "设为制作默认" : "已是制作默认"}</button>
        </div>
      </div>
      {settingsNotice ? <p className="resource-settings-notice" role="status">{settingsNotice}</p> : null}

      <section className="resource-section visual-library" data-tour="resource-visual">
        <ResourceHeading eyebrow="画面资源" title="生成与素材模型" meta={`${readyVisual} 项可直接生产`} />
        {providerLoading ? <div className="region-loading">正在读取画面能力...</div> : providerError ? (
          <ResourceError title="画面能力状态未知" message={providerError} retry={load} />
        ) : <div className="provider-ledger">{visualProviders.map((provider) => <ProviderRow key={provider.id} provider={provider} isDefault={settings?.defaultAssetProviderId === provider.id} canSetDefault={provider.id !== "ai-shot-router-v1"} onSetDefault={(providerId) => void saveDefaults({ defaultAssetProviderId: providerId }, `${provider.label} 已设为默认画面能力。`)} />)}</div>}
      </section>

      <section className="resource-section foundation-registry">
        <ResourceHeading eyebrow="生产底座" title="制作能力" meta="脚本、渲染与机器质检" />
        {providerLoading ? <div className="region-loading">正在读取生产底座...</div> : providerError ? null : (
          <div className="foundation-grid" aria-label="制作能力列表">
            {foundationProviders.map((provider) => <FoundationProvider key={provider.id} provider={provider} />)}
          </div>
        )}
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
      <div><strong>{provider.label}</strong><small>{provider.description ?? provider.id}</small></div>
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

function capabilityLabel(capability: StudioProvider["capability"]): string {
  return ({
    "topic.intelligence": "选题判断",
    "script.draft": "脚本生成",
    "video.render": "视频渲染",
    "quality.review": "机器质检",
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
