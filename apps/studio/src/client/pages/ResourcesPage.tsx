import {
  AlertCircle,
  ArrowUpRight,
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
  StudioProductionRoleBindingKey,
  StudioProductionRecipeId,
  StudioProvider,
  StudioRoleProviderDefaults,
  StudioPublishTarget,
  StudioResourceManifest,
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
const DEFAULT_TOPIC_INSTRUCTION = "优先选择与普通人生活直接相关、能用可靠画面表达、具备明确反差或实用价值、可以发展成系列的题材。高热度但缺少可验证事实、可用画面或独特角度时，应降低推荐或明确放弃。";

interface ProductionRoleDefinition {
  key: StudioProductionRoleBindingKey;
  label: string;
  capability: string;
  preferredProviderId: string;
  responsibility: string;
  mode: "agent" | "model" | "tool";
  selectable?: boolean;
  configurationAnchor?: string;
  configurationLabel?: string;
}

const PRODUCTION_ROLE_DEFINITIONS: ProductionRoleDefinition[] = [
  { key: "script", label: "编剧", capability: "script.draft", preferredProviderId: "codex-screenwriter-v1", responsibility: "把选题写成可拍、可朗读、可核验的逐镜脚本", mode: "agent" },
  { key: "director", label: "视觉导演", capability: "storyboard.plan", preferredProviderId: "api-visual-director-v1", responsibility: "建立视觉圣经并逐镜决定画面来源", mode: "agent" },
  { key: "assets", label: "画面执行", capability: "asset.prepare", preferredProviderId: "ai-shot-router-v1", responsibility: "按导演逐镜方案执行图库、本地素材和生成任务", mode: "tool", selectable: false, configurationAnchor: "visual-providers", configurationLabel: "去画面来源配置" },
  { key: "voice", label: "配音执行", capability: "voice.synthesize", preferredProviderId: "macos-say-v1", responsibility: "按声音演员表执行音色、语速和停顿", mode: "tool", selectable: false, configurationAnchor: "voice-casting", configurationLabel: "去声音演员表配置" },
  { key: "render", label: "剪辑师", capability: "video.render", preferredProviderId: "python-ffmpeg-v1", responsibility: "合成画面、字幕、旁白和音轨", mode: "tool" },
  { key: "technicalReview", label: "技术质检", capability: "quality.review", preferredProviderId: "python-technical-review-v1", responsibility: "检查分辨率、时长、轨道、文件和产物哈希", mode: "tool" },
  { key: "visualReview", label: "视觉审片员", capability: "quality.review.visual", preferredProviderId: "glm-visual-review-v1", responsibility: "用成片关键帧审查构图、连续性和可读性", mode: "model" },
];

const AUTOMATIC_AGENT_ROLES = [
  { label: "选题总编", capability: "topic.intelligence" },
  { label: "系列主理人", capability: "series.plan" },
  { label: "参考片分析师", capability: "reference.grammar" },
  { label: "语义选片师", capability: "asset.rank.semantic" },
  { label: "发行编辑", capability: "publish.copy" },
  { label: "独立质量审计", capability: "role.audit" },
] as const;

export function ResourcesPage() {
  const [providers, setProviders] = useState<StudioProvider[]>([]);
  const [trendSources, setTrendSources] = useState<StudioTrendSource[]>([]);
  const [services, setServices] = useState<StudioTrendService[]>([]);
  const [signals, setSignals] = useState<StudioTrendSignal[]>([]);
  const [capabilities, setCapabilities] = useState<StudioLocalCapability[]>([]);
  const [publishTargets, setPublishTargets] = useState<StudioPublishTarget[]>([]);
  const [resourceManifest, setResourceManifest] = useState<StudioResourceManifest>();
  const [providerLoading, setProviderLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [providerError, setProviderError] = useState<string>();
  const [manifestLimit, setManifestLimit] = useState(16);
  const [trendError, setTrendError] = useState<string>();
  const [serviceError, setServiceError] = useState<string>();
  const [publishError, setPublishError] = useState<string>();
  const [manifestError, setManifestError] = useState<string>();
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
  const [roleProviderDefaults, setRoleProviderDefaults] = useState<StudioRoleProviderDefaults>({});
  const [modelDefaults, setModelDefaults] = useState<Record<string, string>>({});
  const [productionDefaults, setProductionDefaults] = useState<StudioProductionDefaults>(DEFAULT_PRODUCTION_DEFAULTS);
  const [topicInstruction, setTopicInstruction] = useState(DEFAULT_TOPIC_INSTRUCTION);

  const load = useCallback(async () => {
    setProviderLoading(true);
    setTrendLoading(true);
    setProviderError(undefined);
    setTrendError(undefined);
    setServiceError(undefined);
    setPublishError(undefined);
    setManifestError(undefined);
    setSettingsError(undefined);
    const [providerResult, trendResult, serviceResult, signalResult, capabilityResult, settingsResult, publishResult, manifestResult] = await Promise.allSettled([
      studioApi.providers(),
      studioApi.trendSources(),
      studioApi.trendServices(),
      studioApi.trendSignals(undefined, 16),
      studioApi.localCapabilities(),
      studioApi.settings(),
      studioApi.publishTargets(),
      studioApi.resourceManifest(),
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
      setRoleProviderDefaults(settingsResult.value.roleProviderDefaults ?? {});
      setModelDefaults(settingsResult.value.modelDefaults ?? {});
      setProductionDefaults(settingsResult.value.productionDefaults ?? DEFAULT_PRODUCTION_DEFAULTS);
      setTopicInstruction(settingsResult.value.topicStrategy?.customInstruction ?? DEFAULT_TOPIC_INSTRUCTION);
    } else {
      setSettings(undefined);
      setSettingsError(errorMessage(settingsResult.reason));
    }
    if (publishResult.status === "fulfilled") setPublishTargets(publishResult.value);
    else setPublishError(errorMessage(publishResult.reason));
    if (manifestResult.status === "fulfilled") setResourceManifest(manifestResult.value);
    else setManifestError(errorMessage(manifestResult.reason));
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
      if (patch.roleProviderDefaults) setRoleProviderDefaults(updated.roleProviderDefaults ?? {});
      if (patch.modelDefaults) setModelDefaults(updated.modelDefaults ?? {});
      if (patch.productionDefaults) setProductionDefaults(updated.productionDefaults);
      if (patch.topicStrategy) setTopicInstruction(updated.topicStrategy.customInstruction);
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
    ? settings.defaultRecipeId !== defaultRecipeId
      || !sameProductionDefaults(settings.productionDefaults, productionDefaults)
    : false;
  const roleHasChanges = settings
    ? !sameStringRecord(settings.roleProviderDefaults, roleProviderDefaults)
      || !sameStringRecord(settings.modelDefaults, modelDefaults)
    : false;
  const topicHasChanges = settings ? (settings.topicStrategy?.customInstruction ?? DEFAULT_TOPIC_INSTRUCTION) !== topicInstruction.trim() : false;
  const readyFoundation = foundationProviders.filter(isProductionReady).length;
  const usablePublishTargets = publishTargets.filter((target) => target.status === "ready" || target.status === "manual_only").length;

  return (
    <main className="page resources-page">
      <header className="page-header resources-header">
        <div>
          <p className="eyebrow">创作控制室</p>
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
        <a href="#topic-strategy"><Sparkles aria-hidden="true" size={15} />选题策略</a>
        <a href="#trend-connections"><RadioTower aria-hidden="true" size={15} />热点信号</a>
        <a href="#voice-casting"><Sparkles aria-hidden="true" size={15} />声音演员</a>
        <a href="#visual-providers"><Film aria-hidden="true" size={15} />画面来源</a>
        <a href="#resource-manifest"><ListChecks aria-hidden="true" size={15} />资源清单</a>
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

      <section id="topic-strategy" className="resource-section topic-strategy-config" data-tour="topic-strategy">
        <ResourceHeading eyebrow="总编规则" title="选题策略" meta="热度只是信号，最终排序看能不能做成一条值得看的视频" />
        <div className="topic-rubric" aria-label="选题评分标准">
          {[['受众相关', '18%', '是否与明确人群的真实处境相关'], ['系列价值', '18%', '能否连续生产而不是一次性追热'], ['可拍性', '14%', '是否有可靠素材和可见动作'], ['成本效率', '14%', '在预算内能否达到及格线'], ['差异化', '14%', '是否提供通稿之外的新角度'], ['商业价值', '12%', '是否具备长期转化或合作空间'], ['合规安全', '10%', '事实、公共事件与平台风险']].map(([label, weight, detail]) => <article key={label}><span>{weight}</span><strong>{label}</strong><small>{detail}</small></article>)}
        </div>
        <div className="topic-instruction-editor">
          <label className="field"><span>给选题总编的补充偏好</span><textarea aria-label="选题总编补充偏好" rows={5} maxLength={2000} value={topicInstruction} onChange={(event) => setTopicInstruction(event.target.value)} /><small>这段文字参与 Codex 选题排序，但不能覆盖事实核验、合规规则和结构化输出要求。</small></label>
          <div className="configuration-save-row"><span>{topicHasChanges ? "有未保存的选题偏好" : "选题偏好已保存"}</span><button className="button button-primary" type="button" disabled={settingsSaving || !topicHasChanges || !topicInstruction.trim()} onClick={() => void saveDefaults({ topicStrategy: { customInstruction: topicInstruction.trim() } }, "选题总编偏好已保存，下一次刷新候选时生效。") }><Save aria-hidden="true" size={16} />{topicHasChanges ? "保存选题策略" : "已保存"}</button></div>
        </div>
      </section>

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
                    : <span aria-label={service.status === "stopped" ? `${service.label} 未配置地址` : `${service.label} 内部服务已连接`} />}
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
        ) : <div className="provider-ledger">{visualProviders.map((provider) => <ProviderRow
          key={provider.id}
          provider={provider}
          isDefault={settings?.defaultAssetProviderId === provider.id}
          canSetDefault
          selectedModelId={modelDefaults[provider.id]}
          onModelChange={(modelId) => setModelDefaults((current) => {
            const next = { ...current };
            if (modelId) next[provider.id] = modelId;
            else delete next[provider.id];
            return next;
          })}
          onSetDefault={(providerId) => void saveDefaults({ defaultAssetProviderId: providerId }, `${provider.label} 已设为默认画面能力。`)}
        />)}</div>}
      </section>

      <section id="production-roles" className="resource-section foundation-registry">
        <ResourceHeading eyebrow="岗位与模型" title="按角色配置生产能力" meta="先决定谁来做，再决定这个角色使用哪个模型" />
        {providerLoading ? <div className="region-loading">正在读取生产底座...</div> : providerError ? null : (
          <>
            <div className="role-configuration-grid" aria-label="生产角色配置">
              {PRODUCTION_ROLE_DEFINITIONS.map((definition) => {
                const selected = resolveRoleProvider(definition, providers, roleProviderDefaults);
                return <RoleProviderCard
                  key={definition.key}
                  definition={definition}
                  providers={providers}
                  selectedProvider={selected}
                  selectedModelId={selected ? modelDefaults[selected.id] : undefined}
                  onProviderChange={(providerId) => setRoleProviderDefaults((current) => ({ ...current, [definition.key]: providerId }))}
                  onModelChange={(providerId, modelId) => setModelDefaults((current) => withStringSelection(current, providerId, modelId))}
                />;
              })}
            </div>
            <div className="automatic-agent-roster" aria-label="自动参与的 Agent">
              <header><strong>自动参与的 Agent</strong><span>这些角色由工作流按节点调用，不需要逐条记忆配置。</span></header>
              <div>{AUTOMATIC_AGENT_ROLES.map((role) => <AutomaticAgentRole key={role.capability} label={role.label} provider={preferredAutomaticProvider(role.capability, providers)} />)}</div>
            </div>
          </>
        )}
        {settings ? <div className="configuration-save-row foundation-save-row"><span>{roleHasChanges ? "有未保存的角色或模型调整" : "角色配置已同步"}</span><button className="button button-primary" type="button" disabled={settingsSaving || !roleHasChanges} onClick={() => void saveDefaults({ roleProviderDefaults, modelDefaults }, "角色与模型默认值已保存，将从下一条新制作生效。") }><Save aria-hidden="true" size={16} />{roleHasChanges ? "保存角色配置" : "已保存"}</button></div> : null}
      </section>

      <section id="resource-manifest" className="resource-section resource-manifest-section" data-tour="resource-manifest">
        <ResourceHeading eyebrow="权利与来源" title="资源追溯清单" meta={resourceManifest ? `${resourceManifest.totalItems} 项资源 · ${resourceManifest.needsReviewCount} 项待复核` : "逐条记录来源、作者与授权状态"} />
        {manifestError ? <ResourceError title="资源清单读取失败" message={manifestError} retry={load} /> : !resourceManifest ? <div className="region-loading">正在汇总资源清单...</div> : <>
          <div className="resource-manifest-summary" aria-label="资源分类统计">
            {(["visual", "voice", "font", "document", "other"] as const).map((category) => <div key={category}><span>{resourceCategoryLabel(category)}</span><strong>{resourceManifest.categories[category]}</strong></div>)}
            <div className={resourceManifest.needsReviewCount ? "needs-review" : ""}><span>待复核</span><strong>{resourceManifest.needsReviewCount}</strong></div>
          </div>
          {resourceManifest.legacyRunsWithoutManifest ? <p className="resource-manifest-legacy">有 {resourceManifest.legacyRunsWithoutManifest} 条旧任务生成于资源清单上线前，不会补写或伪造历史授权信息。</p> : null}
          {resourceManifest.reconstructedRunCount ? <p className="resource-manifest-legacy" role="status">有 {resourceManifest.reconstructedRunCount} 条发生过付费调用但未完成清单的任务，已从现存产物保守恢复并全部标记为待复核。</p> : null}
          {resourceManifest.unreadableManifestCount ? <p className="resource-manifest-legacy" role="status">有 {resourceManifest.unreadableManifestCount} 条资源清单损坏或不可信，已隔离；其余任务仍可正常查看。</p> : null}
          {resourceManifest.truncatedRunCount ? <p className="resource-manifest-legacy" role="status">当前仅汇总最近 500 条制作，另有 {resourceManifest.truncatedRunCount} 条较早记录未进入本页统计。</p> : null}
          <div className="resource-manifest-ledger" aria-label="资源清单明细">
            {resourceManifest.items.slice(0, manifestLimit).map((item) => {
              const sourceUrl = externalResourceUrl(item.sourceUrl);
              return <article key={`${item.runId}:${item.id}`}>
                <span className={`resource-kind is-${item.category}`}>{resourceCategoryLabel(item.category)}</span>
                <div><strong>{item.creator ?? item.kind}</strong><small>{item.runTitle} · {item.providerId}</small><p>{item.licenseNote ?? "缺少授权说明，需要人工复核。"}</p></div>
                <span className={item.reviewStatus === "recorded" ? "ledger-state is-ready" : "ledger-state"}>{item.reviewStatus === "recorded" ? "已记录" : "待复核"}</span>
                {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" title="核验资源来源"><ArrowUpRight aria-hidden="true" size={15} /></a> : <span />}
              </article>;
            })}
            {resourceManifest.items.length === 0 ? <div className="resource-manifest-empty"><ListChecks aria-hidden="true" size={18} /><span>首条完成制作会在这里生成资源清单。</span></div> : null}
          </div>
          {resourceManifest.items.length > manifestLimit ? <button className="button button-secondary" type="button" onClick={() => setManifestLimit((current) => current + 16)}>显示更多资源（还剩 {resourceManifest.items.length - manifestLimit} 项）</button> : null}
        </>}
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

function resourceCategoryLabel(category: StudioResourceManifest["items"][number]["category"]): string {
  return ({ visual: "画面", voice: "声音", font: "字体", document: "文档", other: "其他" } as const)[category];
}

function externalResourceUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function ResourceError({ title, message, retry }: { title: string; message: string; retry: () => Promise<void> }) {
  return <div className="page-error" role="alert"><AlertCircle aria-hidden="true" size={18} /><span><strong>{title}</strong>{message}</span><button className="icon-button" type="button" onClick={() => void retry()} title="重试"><RefreshCw aria-hidden="true" size={17} /></button></div>;
}

function ProviderRow({ provider, isDefault, canSetDefault, selectedModelId, onModelChange, onSetDefault }: {
  provider: StudioProvider;
  isDefault: boolean;
  canSetDefault: boolean;
  selectedModelId: string | undefined;
  onModelChange: (modelId: string) => void;
  onSetDefault: (providerId: string) => void;
}) {
  const ready = isProductionReady(provider);
  const Icon = provider.billing === "free" ? Film : Sparkles;
  const availableModels = provider.modelProfiles?.filter((model) => model.available) ?? [];
  const staleSelection = selectedModelId && !availableModels.some((model) => model.id === selectedModelId)
    ? selectedModelId
    : undefined;
  const activeModel = provider.modelProfiles?.find((model) => model.id === (selectedModelId ?? provider.defaultModelId));
  const estimate = activeModel?.estimatedCnyPerClip ?? provider.estimatedCnyPerClip;
  return (
    <article className="provider-ledger-row">
      <span className="provider-ledger-icon"><Icon aria-hidden="true" size={18} /></span>
      <div><strong>{provider.label}</strong><small>{provider.description ?? provider.id}</small>{!ready && provider.requirement ? <small className="provider-requirement">{provider.requirement}</small> : null}</div>
      <span>{availableModels.length || selectedModelId ? <label className="provider-model-select"><small>默认模型</small><select aria-label={`${provider.label} 默认模型`} value={selectedModelId ?? ""} onChange={(event) => onModelChange(event.target.value)}><option value="">继承服务默认：{provider.defaultModelId ?? "自动选择"}</option>{staleSelection ? <option value={staleSelection} disabled>已失效：{staleSelection}</option> : null}{availableModels.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}</select></label> : (provider.modes ?? []).slice(0, 3).join(" · ")}</span>
      <strong className={provider.billing === "metered" ? "is-metered" : ""}>{billingLabel(provider.billing)}{estimate !== undefined ? ` · 约 ¥${formatCost(estimate)}/${provider.billingUnit === "run" ? "条" : "镜头"}` : ""}</strong>
      <span className={ready ? "ledger-state is-ready" : "ledger-state"}>{providerReadinessLabel(provider, ready)}</span>
      {ready && canSetDefault ? <button className={isDefault ? "provider-default is-active" : "provider-default"} type="button" disabled={isDefault} onClick={() => onSetDefault(provider.id)}>{isDefault ? "制作默认" : "设为默认"}</button> : <span />}
      {provider.docsUrl ? <a href={provider.docsUrl} target="_blank" rel="noreferrer" title={`${provider.label} 文档`}><ArrowUpRight aria-hidden="true" size={15} /></a> : <span />}
    </article>
  );
}

function billingLabel(billing: StudioProvider["billing"]): string {
  if (billing === "metered") return "按量计费";
  if (billing === "subscription") return "订阅额度";
  return "免费";
}

function RoleProviderCard({ definition, providers, selectedProvider, selectedModelId, onProviderChange, onModelChange }: {
  definition: ProductionRoleDefinition;
  providers: StudioProvider[];
  selectedProvider: StudioProvider | undefined;
  selectedModelId: string | undefined;
  onProviderChange: (providerId: string) => void;
  onModelChange: (providerId: string, modelId: string) => void;
}) {
  const candidates = providers.filter((provider) => provider.capability === definition.capability && provider.kind !== "test");
  const models = selectedProvider?.modelProfiles?.filter((model) => model.available) ?? [];
  const activeModel = selectedProvider?.modelProfiles?.find((model) => model.id === (selectedModelId ?? selectedProvider.defaultModelId));
  const ready = Boolean(selectedProvider && isProductionReady(selectedProvider));
  return <article className={ready ? "role-configuration" : "role-configuration is-unavailable"}>
    <header>
      <span>{definition.label}</span>
      <em className={`role-mode is-${definition.mode}`}>{roleModeLabel(definition.mode)}</em>
    </header>
    <p>{definition.responsibility}</p>
    {definition.selectable === false && definition.configurationAnchor ? <div className="role-linked-configuration">
      <span>当前角色能力</span>
      <strong>{selectedProvider?.label ?? "尚未配置"}</strong>
      <a href={`#${definition.configurationAnchor}`}>{definition.configurationLabel}<ArrowUpRight aria-hidden="true" size={14} /></a>
    </div> : <>
      <label className="field">
        <span>{definition.label}默认能力</span>
        <select
          aria-label={`${definition.label}默认能力`}
          value={selectedProvider?.id ?? ""}
          disabled={candidates.filter(isProductionReady).length < 2}
          onChange={(event) => onProviderChange(event.target.value)}
        >
          {!selectedProvider ? <option value="">未配置</option> : null}
          {candidates.map((provider) => <option key={provider.id} value={provider.id} disabled={!isProductionReady(provider)}>{provider.label}{isProductionReady(provider) ? "" : " · 不可用"}</option>)}
        </select>
      </label>
      {selectedProvider && models.length > 0 ? <label className="field">
        <span>默认模型</span>
        <select aria-label={`${selectedProvider.label}默认模型`} value={selectedModelId ?? ""} onChange={(event) => onModelChange(selectedProvider.id, event.target.value)}>
          <option value="">服务默认：{selectedProvider.defaultModelId ?? "自动选择"}</option>
          {models.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
        </select>
      </label> : <div className="role-runtime-summary"><span>当前执行</span><strong>{activeModel?.label ?? selectedProvider?.defaultModelId ?? selectedProvider?.label ?? "尚未配置"}</strong></div>}
    </>}
    <footer><span>{selectedProvider ? billingLabel(selectedProvider.billing) : "无可用能力"}</span><strong>{selectedProvider ? providerReadinessLabel(selectedProvider, ready) : "需要配置"}</strong></footer>
  </article>;
}

function AutomaticAgentRole({ label, provider }: { label: string; provider: StudioProvider | undefined }) {
  const ready = Boolean(provider && isProductionReady(provider));
  const model = provider?.modelProfiles?.find((item) => item.id === provider.defaultModelId)?.label ?? provider?.defaultModelId;
  return <article className={ready ? "automatic-agent-role" : "automatic-agent-role is-unavailable"}>
    <span className="service-light" />
    <div><strong>{label}</strong><small>{provider?.label ?? "尚未配置"}</small></div>
    <em>{provider?.modes?.join(" · ") ?? model ?? "等待能力接入"}</em>
  </article>;
}

function resolveRoleProvider(
  definition: ProductionRoleDefinition,
  providers: StudioProvider[],
  defaults: StudioRoleProviderDefaults,
): StudioProvider | undefined {
  const candidates = providers.filter((provider) => provider.capability === definition.capability && provider.kind !== "test");
  const configuredId = defaults[definition.key];
  return candidates.find((provider) => provider.id === configuredId)
    ?? candidates.find((provider) => provider.id === definition.preferredProviderId && isProductionReady(provider))
    ?? candidates.find(isProductionReady)
    ?? candidates[0];
}

function preferredAutomaticProvider(capability: string, providers: StudioProvider[]): StudioProvider | undefined {
  const candidates = providers.filter((provider) => provider.capability === capability && provider.kind !== "test");
  return candidates.find(isProductionReady) ?? candidates[0];
}

function roleModeLabel(mode: ProductionRoleDefinition["mode"]): string {
  if (mode === "agent") return "Agent · 三轮内收敛";
  if (mode === "model") return "模型审片";
  return "确定性工具";
}

function withStringSelection(current: Record<string, string>, key: string, value: string): Record<string, string> {
  const next = { ...current };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

function formatCost(value: number): string {
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

function providerReadinessLabel(provider: StudioProvider, ready: boolean): string {
  if (!ready) return provider.status === "planned" ? "规划中" : "需要配置";
  if (provider.billing === "metered") return "已配置";
  if (provider.billing === "subscription") return "已连接";
  return "可用";
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

function sameStringRecord(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
  return JSON.stringify(Object.entries(left ?? {}).sort()) === JSON.stringify(Object.entries(right).sort());
}
