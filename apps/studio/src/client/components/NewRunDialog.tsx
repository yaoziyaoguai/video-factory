import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  Clapperboard,
  FileText,
  Film,
  Image,
  Mic2,
  ScanSearch,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { StudioCreatorSettings, StudioProductionInput, StudioProvider } from "../../shared/api.js";
import { STUDIO_DIRECTOR_PROFILES, type StudioDirectorProfileId } from "../../shared/director-profiles.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { VoiceStudio } from "./VoiceStudio.js";

interface NewRunDialogProps {
  open: boolean;
  providers: StudioProvider[];
  initialValues?: Partial<StudioProductionInput>;
  creatorSettings?: StudioCreatorSettings;
  onClose: () => void;
  onSubmit: (input: StudioProductionInput) => Promise<void>;
}

type BindingKey = keyof StudioProductionInput["providers"];
type RecipeId = StudioProductionInput["economics"]["recipeId"];

interface CapabilityDefinition {
  key: BindingKey;
  capability: string;
  label: string;
  description: string;
  role: string;
  preferred: string;
  icon: LucideIcon;
}

const CAPABILITIES: CapabilityDefinition[] = [
  { key: "script", capability: "script.draft", label: "脚本生成", role: "编剧", description: "结构、钩子与分镜文案", preferred: "python-template-v1", icon: FileText },
  { key: "director", capability: "storyboard.plan", label: "导演方案", role: "导演", description: "视觉圣经与逐镜素材决策", preferred: "ollama-visual-director-v1", icon: Clapperboard },
  { key: "assets", capability: "asset.prepare", label: "画面素材", role: "素材导演", description: "执行 AI 导演生成的逐镜路由", preferred: "ai-shot-router-v1", icon: Image },
  { key: "voice", capability: "voice.synthesize", label: "配音", role: "声音导演", description: "旁白音色与语速", preferred: "macos-say-v1", icon: Mic2 },
  { key: "render", capability: "video.render", label: "视频渲染", role: "剪辑师", description: "9:16 合成、字幕与音轨", preferred: "python-ffmpeg-v1", icon: Film },
  { key: "technicalReview", capability: "quality.review", label: "机器质检", role: "技术质检", description: "分辨率、时长与产物校验", preferred: "python-technical-review-v1", icon: ScanSearch },
];

const RECIPES: Array<{
  id: RecipeId;
  label: string;
  description: string;
  maxPaidShots: number;
  recommended?: boolean;
}> = [
  {
    id: "economy-daily",
    label: "经济日更",
    description: "AI 导演在全部免费来源中逐镜决策",
    maxPaidShots: 0,
    recommended: true,
  },
  {
    id: "free-stock",
    label: "全免费精搜",
    description: "零计费，允许更广的免费素材池",
    maxPaidShots: 0,
  },
  {
    id: "keyshot-ai",
    label: "效果均衡",
    description: "AI 可在预算内选择最多 1 个付费镜头",
    maxPaidShots: 1,
  },
  {
    id: "cinematic-ai",
    label: "精品上限",
    description: "AI 可在预算内选择最多 3 个付费镜头",
    maxPaidShots: 3,
  },
];

export function NewRunDialog({ open, providers, initialValues, creatorSettings, onClose, onSubmit }: NewRunDialogProps) {
  const defaults = useMemo(() => providerDefaults(providers), [providers]);
  const [bindings, setBindings] = useState<StudioProductionInput["providers"]>(defaults);
  const [activeKey, setActiveKey] = useState<BindingKey>("assets");
  const [recipeId, setRecipeId] = useState<RecipeId>("economy-daily");
  const [maxPaidShots, setMaxPaidShots] = useState(0);
  const [budgetCny, setBudgetCny] = useState(0);
  const [directorProfileId, setDirectorProfileId] = useState<StudioDirectorProfileId>("auto");
  const [assetProviderIds, setAssetProviderIds] = useState<string[]>([]);
  const [voiceDirection, setVoiceDirection] = useState<StudioProductionInput["voiceDirection"]>(() => defaultVoiceDirection(providers));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  const activeCapability = CAPABILITIES.find((item) => item.key === activeKey) ?? CAPABILITIES[1]!;
  const activeProviders = providers.filter((provider) => {
    if (provider.capability !== activeCapability.capability || provider.kind === "test") return false;
    return activeKey !== "assets" || provider.id === "ai-shot-router-v1";
  });
  const assetSources = providers.filter((provider) => {
    return provider.capability === "asset.prepare" && provider.kind !== "test" && provider.id !== "ai-shot-router-v1";
  });
  const selectedAssetSources = assetSources.filter((provider) => assetProviderIds.includes(provider.id));
  const selectedMeteredSources = selectedAssetSources.filter((provider) => provider.billing === "metered");
  const meteredSelected = selectedMeteredSources.length > 0 && maxPaidShots > 0;
  const cheapestMeteredClip = Math.min(...selectedMeteredSources.map((provider) => provider.estimatedCnyPerClip ?? Number.POSITIVE_INFINITY));
  const minimumBudget = meteredSelected && Number.isFinite(cheapestMeteredClip)
    ? roundMoney(cheapestMeteredClip * maxPaidShots)
    : 0;
  const displayedBudget = meteredSelected ? Math.max(budgetCny, minimumBudget) : 0;
  const economics: StudioProductionInput["economics"] = {
    recipeId,
    allowMeteredProviders: Boolean(meteredSelected && maxPaidShots > 0 && displayedBudget > 0),
    maxPaidShots: meteredSelected ? maxPaidShots : 0,
    maxCostCny: meteredSelected ? displayedBudget : 0,
  };
  const missingCapabilities = CAPABILITIES.filter((item) => {
    return !providers.some((provider) => provider.capability === item.capability && provider.available && provider.kind !== "test");
  });

  useEffect(() => {
    if (!open) return;
    const initialVoiceDirection = initialValues?.voiceDirection ?? creatorSettings?.voiceDirection ?? defaultVoiceDirection(providers);
    const initialBindings = {
      ...defaults,
      ...(initialValues?.providers ?? {}),
      assets: "ai-shot-router-v1",
      director: "ollama-visual-director-v1",
      voice: providerForVoiceProfile(initialVoiceDirection.profileId),
    };
    const initialRecipe = initialValues?.economics?.recipeId ?? creatorSettings?.defaultRecipeId ?? "economy-daily";
    const recipe = RECIPES.find((item) => item.id === initialRecipe) ?? RECIPES[0]!;
    const initialProfile = initialValues?.director?.profileId ?? "auto";
    const sourceIds = initialValues?.director?.assetProviderIds
      ?? sourceIdsForRecipe(recipe, providers, creatorSettings?.defaultAssetProviderId);
    setBindings(initialBindings);
    setRecipeId(recipe.id);
    setMaxPaidShots(initialValues?.economics?.maxPaidShots ?? recipe.maxPaidShots);
    setBudgetCny(initialValues?.economics?.maxCostCny ?? estimatedRecipeBudget(recipe, sourceIds, providers));
    setDirectorProfileId(initialProfile);
    setAssetProviderIds(sourceIds);
    setVoiceDirection(initialVoiceDirection);
    setActiveKey("assets");
    setAdvancedOpen(false);
    setError(undefined);
  }, [creatorSettings, defaults, open, providers]);

  if (!open) return null;

  function applyRecipe(nextId: RecipeId) {
    const recipe = RECIPES.find((item) => item.id === nextId) ?? RECIPES[0]!;
    const sourceIds = sourceIdsForRecipe(recipe, providers);
    setRecipeId(nextId);
    setMaxPaidShots(recipe.maxPaidShots);
    setBindings((current) => ({ ...current, assets: "ai-shot-router-v1" }));
    setAssetProviderIds(sourceIds);
    setBudgetCny(estimatedRecipeBudget(recipe, sourceIds, providers));
    setActiveKey("assets");
  }

  function selectProvider(provider: StudioProvider) {
    if (!provider.available) return;
    setBindings((current) => ({ ...current, [activeKey]: provider.id }));
  }

  function toggleAssetProvider(provider: StudioProvider) {
    if (!provider.available || (provider.billing === "metered" && maxPaidShots === 0)) return;
    setAssetProviderIds((current) => {
      if (current.includes(provider.id)) {
        return current.length === 1 ? current : current.filter((id) => id !== provider.id);
      }
      return [...current, provider.id];
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit({
        protocolVersion: "video-factory/brief-v1",
        title: requiredString(data, "title"),
        angle: requiredString(data, "angle"),
        audience: requiredString(data, "audience"),
        nicheSlug: initialValues?.nicheSlug ?? topicSlug(requiredString(data, "title")),
        durationSeconds: Number(data.get("durationSeconds")),
        platform: requiredString(data, "platform"),
        reviewMode: data.get("reviewMode") === "automatic" ? "automatic" : "manual",
        voiceDirection,
        providers: bindings,
        director: { profileId: directorProfileId, assetProviderIds },
        economics,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section ref={dialogRef} className="run-dialog recipe-dialog" role="dialog" aria-modal="true" aria-labelledby="new-run-title" tabIndex={-1}>
        <header className="dialog-header recipe-dialog-header">
          <div>
            <p className="eyebrow">制作方案</p>
            <h2 id="new-run-title">新建制作</h2>
            <p>先定内容与预计成本，再选择合适的画面和声音能力。</p>
          </div>
          <div className="dialog-budget" aria-label="当前预算">
            <span>{meteredSelected ? `${maxPaidShots} 个付费镜头上限` : "仅使用免费能力"}</span>
            <strong>¥{formatMoney(displayedBudget)}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭">
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <form className="run-form recipe-form" onSubmit={submit} key={initialValues?.title ?? "blank-production"}>
          <div className="recipe-form-scroll">
            <section className="brief-section" aria-labelledby="brief-section-title">
              <div className="compact-section-heading">
                <div><span>01</span><h3 id="brief-section-title">内容简报</h3></div>
                <small>所有字段都可在生产前调整</small>
              </div>
              <div className="brief-fields">
                <label className="field field-wide">
                  <span>视频标题</span>
                  <input name="title" required data-dialog-initial-focus defaultValue={initialValues?.title ?? ""} placeholder="一句能让人停下来的具体承诺" />
                </label>
                <label className="field field-wide">
                  <span>内容角度</span>
                  <input name="angle" required defaultValue={initialValues?.angle ?? ""} placeholder="这条视频用什么独特角度讲清问题" />
                </label>
                <label className="field">
                  <span>目标受众</span>
                  <input name="audience" required defaultValue={initialValues?.audience ?? ""} placeholder="这条视频最想帮助谁" />
                </label>
                <label className="field field-compact">
                  <span>目标平台</span>
                  <select name="platform" defaultValue={initialValues?.platform ?? "douyin"}>
                    <option value="douyin">抖音</option>
                    <option value="xiaohongshu">小红书</option>
                    <option value="bilibili">哔哩哔哩</option>
                  </select>
                </label>
                <label className="field field-compact">
                  <span>视频时长</span>
                  <select name="durationSeconds" defaultValue={String(initialValues?.durationSeconds ?? 24)}>
                    <option value="20">20 秒</option>
                    <option value="24">24 秒</option>
                    <option value="30">30 秒</option>
                    <option value="45">45 秒</option>
                  </select>
                </label>
              </div>
            </section>

            <section className="director-casting-section" aria-labelledby="director-casting-title">
              <div className="compact-section-heading">
                <div><span>02</span><h3 id="director-casting-title">导演角色</h3></div>
                <small>角色定创作立场，AI 仍逐镜做决定</small>
              </div>
              <div className="director-casting-control">
                <label className="field">
                  <span>导演角色</span>
                  <select value={directorProfileId} onChange={(event) => setDirectorProfileId(event.target.value as StudioDirectorProfileId)}>
                    {STUDIO_DIRECTOR_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                  </select>
                </label>
                {(() => {
                  const profile = STUDIO_DIRECTOR_PROFILES.find((item) => item.id === directorProfileId) ?? STUDIO_DIRECTOR_PROFILES[0]!;
                  return <div className="director-profile-note"><strong>{profile.inspiration}</strong><span>{profile.summary}</span><small>擅长：{profile.bestFor}</small></div>;
                })()}
              </div>
            </section>

            <section className="recipe-section" aria-labelledby="recipe-section-title" data-tour="production-recipes">
              <div className="compact-section-heading">
                <div><span>03</span><h3 id="recipe-section-title">成本策略</h3></div>
                <small>只约束预算，不规定素材组合</small>
              </div>
              <fieldset className="recipe-options">
                <legend className="sr-only">制作配方</legend>
                {RECIPES.map((recipe) => {
                  const available = recipeAvailable(recipe, providers);
                  return (
                  <label key={recipe.id} className={available ? "recipe-option" : "recipe-option is-disabled"}>
                    <input type="radio" name="recipe" value={recipe.id} checked={recipeId === recipe.id} disabled={!available} onChange={() => applyRecipe(recipe.id)} />
                    <span className="recipe-option-body">
                      <span className="recipe-name">{recipe.recommended ? <Check aria-hidden="true" size={14} /> : <Sparkles aria-hidden="true" size={14} />}<strong>{recipe.label}</strong></span>
                      <small>{available ? recipe.description : `${recipe.description} · 需要先配置对应能力`}</small>
                    </span>
                  </label>
                  );
                })}
              </fieldset>
            </section>

            <div className={advancedOpen ? "advanced-production is-open" : "advanced-production"}>
              <button className="advanced-production-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                <span>高级：逐节点配置</span><small>制作能力与人工终审</small><ChevronDown aria-hidden="true" size={17} />
              </button>
              {advancedOpen ? <section className="workflow-config" aria-labelledby="workflow-config-title">
              <div className="workflow-stage-panel">
                <div className="compact-section-heading workflow-heading">
                  <div><span>A</span><h3 id="workflow-config-title">制作节点</h3></div>
                  <small>点击节点更换能力</small>
                </div>
                <div className="workflow-stage-list">
                  {CAPABILITIES.map((item, index) => {
                    const selected = providers.find((provider) => provider.id === bindings[item.key]);
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.key}
                        className={activeKey === item.key ? "workflow-stage is-active" : "workflow-stage"}
                        type="button"
                        onClick={() => setActiveKey(item.key)}
                        aria-pressed={activeKey === item.key}
                      >
                        <span className="stage-index">{String(index + 1).padStart(2, "0")}</span>
                        <Icon aria-hidden="true" size={17} />
                        <span><strong>{item.label}<em>{item.role}</em></strong><small>{selected?.label ?? "未配置"}</small></span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="provider-browser">
                <header className="provider-browser-header">
                  <div><p>{activeCapability.label}</p><h3>{activeCapability.description}</h3></div>
                  <span>{activeProviders.filter((provider) => provider.available).length} 项可用</span>
                </header>
                <div className="provider-choice-list">
                  {activeProviders.map((provider) => {
                    const selected = bindings[activeKey] === provider.id;
                    return (
                      <label key={provider.id} className={selected ? "provider-choice is-selected" : "provider-choice"}>
                        <input
                          type="radio"
                          name={`provider-${activeKey}`}
                          value={provider.id}
                          checked={selected}
                          disabled={!provider.available}
                          onChange={() => selectProvider(provider)}
                        />
                        <span className="provider-choice-main">
                          <span className="provider-choice-title">
                            <strong>{provider.label}</strong>
                            <span className={provider.billing === "metered" ? "cost-tag is-metered" : "cost-tag"}>
                              {provider.billing === "metered"
                                ? provider.estimatedCnyPerClip === undefined
                                  ? "待估价"
                                  : `约 ¥${formatMoney(provider.estimatedCnyPerClip)}/镜头`
                                : "免费"}
                            </span>
                          </span>
                          <span>{provider.description ?? provider.id}</span>
                          <span className="provider-mode-list">{(provider.modes ?? []).map((mode) => <small key={mode}>{mode}</small>)}</span>
                        </span>
                        <span className="provider-choice-status">
                          {provider.available ? <Check aria-hidden="true" size={15} /> : <AlertCircle aria-hidden="true" size={15} />}
                          {provider.available ? "可用" : provider.status === "planned" ? "待接入" : "待配置"}
                        </span>
                        {!provider.available && provider.requirement ? <small className="provider-requirement">{provider.requirement}</small> : null}
                      </label>
                    );
                  })}
                </div>
              </div>
              </section> : null}
              {advancedOpen ? <section className="asset-source-pool" aria-labelledby="asset-source-pool-title">
                <div className="compact-section-heading">
                  <div><span>B</span><h3 id="asset-source-pool-title">导演可用素材池</h3></div>
                  <small>{assetProviderIds.length} 项已启用，最终组合由 AI 生成</small>
                </div>
                <div className="asset-source-options">
                  {assetSources.map((provider) => {
                    const checked = assetProviderIds.includes(provider.id);
                    const disabled = !provider.available
                      || (provider.billing === "metered" && maxPaidShots === 0)
                      || (checked && assetProviderIds.length === 1);
                    return <label key={provider.id} className={checked ? "asset-source-option is-selected" : "asset-source-option"}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAssetProvider(provider)}
                      />
                      <span><strong>{provider.label}</strong><small>{provider.description ?? provider.id}</small></span>
                      <em>{provider.billing === "metered" ? provider.estimatedCnyPerClip ? `约 ¥${formatMoney(provider.estimatedCnyPerClip)}/镜头` : "待估价" : "免费"}</em>
                    </label>;
                  })}
                </div>
              </section> : null}
            </div>

            <VoiceStudio
              sectionLabel="04"
              value={voiceDirection}
              onChange={(next, providerId) => {
                setVoiceDirection(next);
                setBindings((current) => ({ ...current, voice: providerId }));
              }}
            />

            <section className="production-guardrails" aria-label="生产门禁">
              <fieldset className="segmented-control review-control">
                <legend>终审模式</legend>
                <label><input type="radio" name="reviewMode" value="manual" defaultChecked /><span>人工终审</span></label>
                <label><input type="radio" name="reviewMode" value="automatic" /><span>跳过人工终审</span></label>
              </fieldset>
              <label className="budget-control">
                <span><CircleDollarSign aria-hidden="true" size={16} /><strong>预计成本上限</strong></span>
                <span className="budget-input"><span>¥</span><input aria-label="预计成本上限" type="number" min={minimumBudget} step="0.1" value={displayedBudget} disabled={!meteredSelected} onChange={(event) => setBudgetCny(Number(event.target.value))} /></span>
                <small>{meteredSelected ? `按当前估价最多 ${maxPaidShots} 个计费镜头，预计最低 ¥${formatMoney(minimumBudget)}` : "当前配方不会主动调用计费 API"}</small>
              </label>
            </section>

            {missingCapabilities.length > 0 ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />缺少正式生产能力：{missingCapabilities.map((item) => item.label).join("、")}。请先在素材与模型中完成配置。</p> : null}
            {error ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          </div>

          <footer className="dialog-actions recipe-dialog-actions">
            <div><strong>{RECIPES.find((recipe) => recipe.id === recipeId)?.label}</strong><span>{meteredSelected ? `预计上限 ¥${formatMoney(displayedBudget)}` : "免费制作路径"}</span></div>
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting || missingCapabilities.length > 0} data-tour="production-start">
              <Check aria-hidden="true" size={17} />
              {submitting ? "正在创建..." : "开始制作"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function defaultVoiceDirection(providers: StudioProvider[]): StudioProductionInput["voiceDirection"] {
  const kokoroReady = providers.some((provider) => provider.id === "kokoro-local-v1" && provider.available);
  return {
    profileId: kokoroReady ? "kokoro:zf_001" : "macos:Tingting",
    rate: 185,
    pauseScale: 1,
    masteringPreset: "natural",
  };
}

function providerDefaults(providers: StudioProvider[]): StudioProductionInput["providers"] {
  return Object.fromEntries(CAPABILITIES.map((item) => {
    const candidates = providers.filter((provider) => provider.capability === item.capability && provider.kind !== "test");
    const preferredId = item.key === "voice"
      ? providerForVoiceProfile(defaultVoiceDirection(providers).profileId)
      : item.preferred;
    const selected = candidates.find((provider) => provider.id === preferredId && provider.available)
      ?? candidates.find((provider) => provider.available);
    return [item.key, selected?.id ?? ""];
  })) as StudioProductionInput["providers"];
}

function providerForVoiceProfile(profileId: string): string {
  if (profileId.startsWith("kokoro:")) return "kokoro-local-v1";
  if (profileId.startsWith("tone:")) return "ffmpeg-tone-test-v1";
  return "macos-say-v1";
}

function estimatedRecipeBudget(
  recipe: (typeof RECIPES)[number],
  assetProviderIds: string[],
  providers: StudioProvider[],
): number {
  const price = Math.min(...providers
    .filter((provider) => assetProviderIds.includes(provider.id) && provider.billing === "metered" && provider.estimatedCnyPerClip)
    .map((provider) => provider.estimatedCnyPerClip!));
  return Number.isFinite(price) ? roundMoney(price * recipe.maxPaidShots) : 0;
}

function recipeAvailable(recipe: (typeof RECIPES)[number], providers: StudioProvider[]): boolean {
  const foundationReady = providers.some((provider) => provider.id === "ollama-visual-director-v1" && provider.available)
    && providers.some((provider) => provider.id === "ai-shot-router-v1" && provider.available);
  if (!foundationReady) return false;
  if (recipe.maxPaidShots === 0) {
    return providers.some((provider) => isAssetSource(provider) && provider.available && provider.billing !== "metered");
  }
  return providers.some((provider) => {
    return provider.available
      && isAssetSource(provider)
      && provider.billing === "metered"
      && provider.estimatedCnyPerClip !== undefined
      && provider.estimatedCnyPerClip > 0;
  });
}

function sourceIdsForRecipe(
  recipe: (typeof RECIPES)[number],
  providers: StudioProvider[],
  preferredId?: string,
): string[] {
  const free = providers
    .filter((provider) => isAssetSource(provider) && provider.available && provider.billing !== "metered")
    .map((provider) => provider.id);
  if (preferredId && providers.some((provider) => provider.id === preferredId && provider.available) && !free.includes(preferredId)) {
    free.push(preferredId);
  }
  if (recipe.maxPaidShots === 0) return free;
  const metered = providers
    .filter((provider) => isAssetSource(provider) && provider.available && provider.billing === "metered" && provider.estimatedCnyPerClip)
    .sort((left, right) => (left.estimatedCnyPerClip ?? Infinity) - (right.estimatedCnyPerClip ?? Infinity))[0];
  return metered ? [...free, metered.id] : free;
}

function isAssetSource(provider: StudioProvider): boolean {
  return provider.capability === "asset.prepare" && provider.kind !== "test" && provider.id !== "ai-shot-router-v1";
}

function requiredString(data: FormData, key: string): string {
  const value = data.get(key);
  const labels: Record<string, string> = { title: "视频标题", angle: "内容角度", audience: "目标受众", platform: "目标平台" };
  if (typeof value !== "string" || !value.trim()) throw new Error(`${labels[key] ?? key}不能为空。`);
  return value.trim();
}

function topicSlug(title: string): string {
  let hash = 2166136261;
  for (const character of title) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `topic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMoney(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
