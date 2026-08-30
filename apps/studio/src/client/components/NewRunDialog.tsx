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
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { StudioCreatorSettings, StudioProductionInput, StudioProvider, StudioReferenceVideo, StudioTemplate } from "../../shared/api.js";
import { STUDIO_DIRECTOR_PROFILES, type StudioDirectorProfileId } from "../../shared/director-profiles.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { VoiceStudio } from "./VoiceStudio.js";
import { studioApi } from "../api.js";
import { TemplateGallery } from "../templates/TemplateGallery.js";

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
  optional?: boolean;
}

const CAPABILITIES: CapabilityDefinition[] = [
  { key: "script", capability: "script.draft", label: "脚本生成", role: "编剧", description: "结构、钩子与分镜文案", preferred: "codex-screenwriter-v1", icon: FileText },
  { key: "director", capability: "storyboard.plan", label: "导演方案", role: "导演", description: "视觉圣经与逐镜素材决策", preferred: "api-visual-director-v1", icon: Clapperboard },
  { key: "assets", capability: "asset.prepare", label: "画面素材", role: "素材导演", description: "执行 AI 导演生成的逐镜路由", preferred: "ai-shot-router-v1", icon: Image },
  { key: "voice", capability: "voice.synthesize", label: "配音", role: "声音导演", description: "旁白音色与语速", preferred: "macos-say-v1", icon: Mic2 },
  { key: "render", capability: "video.render", label: "视频渲染", role: "剪辑师", description: "9:16 合成、字幕与音轨", preferred: "python-ffmpeg-v1", icon: Film },
  { key: "technicalReview", capability: "quality.review", label: "机器质检", role: "技术质检", description: "分辨率、时长与产物校验", preferred: "python-technical-review-v1", icon: ScanSearch },
  { key: "visualReview", capability: "quality.review.visual", label: "视觉审片", role: "视觉审片员", description: "构图、连续性、节奏与文字可读性", preferred: "glm-visual-review-v1", icon: ScanSearch, optional: true },
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
  const [platform, setPlatform] = useState("douyin");
  const [durationSeconds, setDurationSeconds] = useState(24);
  const [assetProviderIds, setAssetProviderIds] = useState<string[]>([]);
  const [modelSelections, setModelSelections] = useState<Record<string, string>>({});
  const [voiceDirection, setVoiceDirection] = useState<StudioProductionInput["voiceDirection"]>(() => defaultVoiceDirection(providers));
  const [visualReviewEnabled, setVisualReviewEnabled] = useState(false);
  const [semanticRankEnabled, setSemanticRankEnabled] = useState(true);
  const [referenceVideo, setReferenceVideo] = useState<StudioReferenceVideo>();
  const releasedReferenceId = useRef<string | undefined>(undefined);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [referenceError, setReferenceError] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    initialValues?.editorial?.verdict === "produce_image_story" ? "photo-story" : "knowledge-explainer",
  );
  const [templateError, setTemplateError] = useState<string>();
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  const activeCapability = CAPABILITIES.find((item) => item.key === activeKey) ?? CAPABILITIES[1]!;
  const editorial = initialValues?.editorial;
  const imageStory = editorial?.verdict === "produce_image_story";
  const activeProviders = providers.filter((provider) => {
    if (provider.capability !== activeCapability.capability || provider.kind === "test") return false;
    return activeKey !== "assets" || provider.id === "ai-shot-router-v1";
  });
  const assetSources = providers.filter((provider) => {
    return provider.capability === "asset.prepare" && provider.kind !== "test" && provider.id !== "ai-shot-router-v1";
  });
  const selectedAssetSources = assetSources.filter((provider) => assetProviderIds.includes(provider.id));
  const selectedMeteredSources = selectedAssetSources.filter((provider) => provider.billing === "metered");
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const effectiveModelId = (provider: StudioProvider) => modelSelections[provider.id]
    ?? selectedTemplate?.modelDefaults?.[provider.id]
    ?? creatorSettings?.modelDefaults?.[provider.id]
    ?? provider.defaultModelId;
  const visualReviewProvider = providers.find((provider) => {
    return provider.capability === "quality.review.visual" && provider.id === bindings.visualReview && provider.available;
  }) ?? providers.find((provider) => provider.capability === "quality.review.visual" && provider.available);
  const referenceGrammarProvider = providers.find((provider) => {
    return provider.id === "codex-reference-grammar-v1" && provider.capability === "reference.grammar" && provider.available;
  });
  const semanticRankCompatible = Boolean(bindings.director && bindings.assets === "ai-shot-router-v1");
  const effectiveSemanticRank = semanticRankCompatible && semanticRankEnabled;
  const meteredSelected = selectedMeteredSources.length > 0 && maxPaidShots > 0;
  const meteredVisualReview = visualReviewEnabled && visualReviewProvider?.billing === "metered"
    ? visualReviewProvider
    : undefined;
  const meteredVoiceProvider = providers.find((provider) => {
    return provider.capability === "voice.synthesize"
      && provider.id === bindings.voice
      && provider.available
      && provider.billing === "metered";
  });
  const visualReviewEstimate = meteredVisualReview?.estimatedCnyPerClip ?? 0;
  const voiceEstimate = meteredVoiceProvider?.estimatedCnyPerClip ?? 0;
  const hasMeteredCalls = meteredSelected || meteredVisualReview !== undefined || meteredVoiceProvider !== undefined;
  const highestMeteredClip = Math.max(...selectedMeteredSources.map((provider) => selectedModelEstimate(provider, effectiveModelId(provider)) ?? Number.NEGATIVE_INFINITY));
  const minimumBudget = meteredSelected && Number.isFinite(highestMeteredClip)
    ? roundMoney(highestMeteredClip * maxPaidShots)
    : 0;
  const displayedBudget = meteredSelected ? Math.max(budgetCny, minimumBudget) : 0;
  const displayedTotalEstimate = roundMoney(displayedBudget + visualReviewEstimate + voiceEstimate);
  const economics: StudioProductionInput["economics"] = {
    recipeId,
    allowMeteredProviders: hasMeteredCalls,
    maxPaidShots: meteredSelected ? maxPaidShots : 0,
    maxCostCny: meteredSelected ? displayedBudget : 0,
  };
  const missingCapabilities = CAPABILITIES.filter((item) => {
    return !item.optional
      && !providers.some((provider) => provider.capability === item.capability && provider.available && provider.kind !== "test");
  });

  useEffect(() => {
    if (!open) return;
    const initialVoiceDirection = initialValues?.voiceDirection ?? creatorSettings?.voiceDirection ?? defaultVoiceDirection(providers);
    const requestedVoiceProvider = providerForVoiceProfile(initialVoiceDirection.profileId);
    const readyVoiceProvider = providers.find((provider) => {
      return provider.id === requestedVoiceProvider && provider.capability === "voice.synthesize" && provider.available && provider.kind !== "test";
    });
    const resolvedVoiceDirection = readyVoiceProvider ? initialVoiceDirection : defaultVoiceDirection(providers);
    const initialBindings = {
      ...defaults,
      ...(initialValues?.providers ?? {}),
      assets: "ai-shot-router-v1",
      director: defaults.director ?? "",
      voice: providerForVoiceProfile(resolvedVoiceDirection.profileId),
    };
    const initialRecipe = imageStory
      ? "free-stock"
      : initialValues?.economics?.recipeId ?? creatorSettings?.defaultRecipeId ?? "economy-daily";
    const recipe = RECIPES.find((item) => item.id === initialRecipe) ?? RECIPES[0]!;
    const initialProfile = initialValues?.director?.profileId ?? creatorSettings?.productionDefaults?.directorProfileId ?? "auto";
    const sourceIds = initialValues?.director?.assetProviderIds
      ?? sourceIdsForRecipe(recipe, providers, creatorSettings?.defaultAssetProviderId);
    setBindings(initialBindings);
    setRecipeId(recipe.id);
    setMaxPaidShots(imageStory ? 0 : initialValues?.economics?.maxPaidShots ?? recipe.maxPaidShots);
    setBudgetCny(imageStory ? 0 : initialValues?.economics?.maxCostCny ?? estimatedRecipeBudget(recipe, sourceIds, providers));
    setDirectorProfileId(initialProfile);
    setPlatform(initialValues?.platform ?? creatorSettings?.productionDefaults?.platform ?? "douyin");
    setDurationSeconds(initialValues?.durationSeconds ?? creatorSettings?.productionDefaults?.durationSeconds ?? 24);
    setAssetProviderIds(sourceIds);
    // 只有用户或入口明确指定的模型才属于本次覆盖。全局/模板默认值由服务端按优先级解析。
    setModelSelections({ ...(initialValues?.models ?? {}) });
    setVoiceDirection(resolvedVoiceDirection);
    setVisualReviewEnabled(Boolean(initialBindings.visualReview && providers.some((provider) => {
      return provider.id === initialBindings.visualReview && provider.available;
    })));
    setSemanticRankEnabled(initialValues?.workflowFeatures?.assetSemanticRank ?? Boolean(initialBindings.director));
    setReferenceVideo(undefined);
    setReferenceUploading(false);
    setReferenceError(undefined);
    setActiveKey("assets");
    setAdvancedOpen(false);
    setError(undefined);
    const requestedTemplateId = imageStory ? "photo-story" : initialValues?.editorial ? "trend-fact-brief" : "knowledge-explainer";
    setSelectedTemplateId(requestedTemplateId);
    setTemplateError(undefined);
    setTemplates([]);
    setTemplatesLoaded(false);
    void studioApi.templates()
      .then((catalog) => {
        const published = catalog.templates.filter((template) => template.status === "published");
        if (published.length === 0) throw new Error("模板目录中没有已发布模板。");
        setTemplates(published);
        if (published.some((template) => template.id === requestedTemplateId)) {
          setSelectedTemplateId(requestedTemplateId);
        } else {
          setSelectedTemplateId(published[0]!.id);
          setDurationSeconds(published[0]!.durationSeconds);
        }
        setTemplatesLoaded(true);
      })
      .catch((caught) => setTemplateError(`无法读取模板目录：${caught instanceof Error ? caught.message : String(caught)} 请重试后再开始制作。`));
  }, [creatorSettings, defaults, imageStory, open, providers]);

  useEffect(() => {
    if (!open || !referenceVideo) return;
    const uploadId = referenceVideo.uploadId;
    return () => {
      if (releasedReferenceId.current !== uploadId) void studioApi.deleteReferenceVideo(uploadId).catch(() => undefined);
    };
  }, [open, referenceVideo]);

  if (!open) return null;

  function applyRecipe(nextId: RecipeId) {
    const recipe = RECIPES.find((item) => item.id === nextId) ?? RECIPES[0]!;
    if (imageStory && recipe.maxPaidShots > 0) return;
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
    if (activeKey === "visualReview") setVisualReviewEnabled(true);
  }

  function toggleAssetProvider(provider: StudioProvider) {
    if (!provider.available || (provider.billing === "metered" && maxPaidShots === 0)) return;
    setAssetProviderIds((current) => {
      const baselineId = requiredFreeBaselineId(current, providers);
      if (current.includes(provider.id)) {
        if (provider.id === baselineId) return current;
        return current.length === 1 ? current : current.filter((id) => id !== provider.id);
      }
      return [...current, provider.id];
    });
  }

  async function uploadReferenceVideo(file?: File) {
    if (!file) return;
    setReferenceUploading(true);
    setReferenceError(undefined);
    try {
      setReferenceVideo(await studioApi.uploadReferenceVideo(file));
    } catch (caught) {
      setReferenceVideo(undefined);
      setReferenceError(caught instanceof Error ? caught.message : "参考视频上传失败。");
    } finally {
      setReferenceUploading(false);
    }
  }

  async function removeReferenceVideo() {
    if (!referenceVideo) return;
    setReferenceUploading(true);
    setReferenceError(undefined);
    try {
      await studioApi.deleteReferenceVideo(referenceVideo.uploadId);
      releasedReferenceId.current = referenceVideo.uploadId;
      setReferenceVideo(undefined);
    } catch (caught) {
      setReferenceError(caught instanceof Error ? caught.message : "参考视频删除失败。");
    } finally {
      setReferenceUploading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setSubmitting(true);
    setError(undefined);
    try {
      if (!templatesLoaded || !templates.some((template) => template.id === selectedTemplateId)) {
        throw new Error(templateError ?? "模板目录尚未加载完成，请稍后重试。");
      }
      const selectedTemplate = templates.find((template) => template.id === selectedTemplateId)!;
      const providersForRun: StudioProductionInput["providers"] = { ...bindings };
      if (visualReviewEnabled && visualReviewProvider) providersForRun.visualReview = visualReviewProvider.id;
      else delete providersForRun.visualReview;
      await onSubmit({
        protocolVersion: "video-factory/brief-v1",
        title: requiredString(data, "title"),
        angle: requiredString(data, "angle"),
        audience: requiredString(data, "audience"),
        nicheSlug: initialValues?.nicheSlug ?? topicSlug(requiredString(data, "title")),
        durationSeconds,
        platform,
        reviewMode: "manual",
        ...(editorial ? { editorial } : {}),
        ...(initialValues?.seriesContext ? { seriesContext: initialValues.seriesContext } : {}),
        ...(initialValues?.creationContext ? { creationContext: initialValues.creationContext } : {}),
        voiceDirection,
        template: {
          templateId: selectedTemplateId,
          runOverrides: { durationSeconds, automationLevel: selectedTemplate.automationLevel },
        },
        providers: providersForRun,
        models: Object.fromEntries(assetProviderIds.flatMap((providerId) => {
          const modelId = modelSelections[providerId];
          return modelId ? [[providerId, modelId]] : [];
        })),
        workflowFeatures: { assetSemanticRank: effectiveSemanticRank, referenceGrammar: Boolean(referenceVideo) },
        ...(referenceVideo ? { referenceVideo: { uploadId: referenceVideo.uploadId, label: referenceVideo.label } } : {}),
        director: { profileId: directorProfileId, assetProviderIds },
        economics,
      });
      if (referenceVideo) releasedReferenceId.current = referenceVideo.uploadId;
      setReferenceVideo(undefined);
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
            <span>{hasMeteredCalls
              ? [
                  meteredSelected ? `${maxPaidShots} 个付费镜头上限` : "",
                  meteredVoiceProvider ? "1 次付费配音" : "",
                  meteredVisualReview ? "1 次付费审片" : "",
                ].filter(Boolean).join(" + ")
              : "无按量 API 扣费"}</span>
            <strong>¥{formatMoney(displayedTotalEstimate)}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭新建制作">
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <form className="run-form recipe-form" onSubmit={submit} key={initialValues?.title ?? "blank-production"}>
          <div className="recipe-form-scroll">
            <section className="template-picker-section" aria-labelledby="template-picker-title">
              <div className="compact-section-heading">
                <div><span>00</span><h3 id="template-picker-title">视频模板</h3></div>
                <small>模板决定叙事语法，不锁死模型和素材</small>
              </div>
              {templates.length > 0 ? (
                <TemplateGallery
                  templates={templates}
                  selectedId={selectedTemplateId}
                  onSelect={(template) => {
                    setSelectedTemplateId(template.id);
                    setDurationSeconds(template.durationSeconds);
                  }}
                />
              ) : (
                <div className="template-loading" aria-live="polite">
                  <strong>{selectedTemplateId === "photo-story" ? "照片故事" : "知识解释"}</strong>
                  <span>{templateError ?? "正在读取模板目录..."}</span>
                </div>
              )}
            </section>
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
                  <select name="platform" value={platform} onChange={(event) => setPlatform(event.target.value)}>
                    <option value="douyin">抖音</option>
                    <option value="xiaohongshu">小红书</option>
                    <option value="bilibili">哔哩哔哩</option>
                  </select>
                </label>
                <label className="field field-compact">
                  <span>视频时长</span>
                  <select name="durationSeconds" value={String(durationSeconds)} onChange={(event) => setDurationSeconds(Number(event.target.value))}>
                    {![20, 24, 30, 36, 40, 42, 45, 60].includes(durationSeconds) ? <option value={durationSeconds}>{durationSeconds} 秒</option> : null}
                    <option value="20">20 秒</option>
                    <option value="24">24 秒</option>
                    <option value="30">30 秒</option>
                    <option value="36">36 秒</option>
                    <option value="40">40 秒</option>
                    <option value="42">42 秒</option>
                    <option value="45">45 秒</option>
                    <option value="60">60 秒</option>
                  </select>
                </label>
              </div>
              {imageStory ? (
                <div className="editorial-brief-note" role="note">
                  <strong>总编建议 · 图文成片</strong>
                  <span>{editorial?.reasons[0]}</span>
                  <small>{editorial?.guardrails[0]}</small>
                </div>
              ) : null}
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

            <section className="reference-style-section" aria-labelledby="reference-style-title">
              <div className="compact-section-heading">
                <div><span>02B</span><h3 id="reference-style-title">参考镜头语法</h3></div>
                <small>可选，不复制参考内容</small>
              </div>
              <div className={referenceVideo ? "reference-video-control has-file" : "reference-video-control"}>
                <label className={referenceGrammarProvider ? "reference-video-picker" : "reference-video-picker is-disabled"}>
                  <input
                    aria-label="参考视频"
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    disabled={!referenceGrammarProvider || referenceUploading}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void uploadReferenceVideo(file);
                    }}
                  />
                  <Upload aria-hidden="true" size={19} />
                  <span><strong>{referenceUploading ? "正在安全上传..." : referenceVideo ? referenceVideo.label : "选择 MP4、MOV 或 WebM"}</strong><small>{referenceVideo ? `${formatBytes(referenceVideo.sizeBytes)} · 上传完成` : "不超过 30 MB；未开工上传最多保留 7 天"}</small></span>
                </label>
                {referenceVideo ? <button className="icon-button reference-video-remove" type="button" title="删除参考视频" aria-label="删除参考视频" disabled={referenceUploading} onClick={() => void removeReferenceVideo()}><X aria-hidden="true" size={17} /></button> : null}
              </div>
              <p className="reference-style-note"><Film aria-hidden="true" size={16} /><span><strong>{referenceGrammarProvider?.label ?? "参考视频分析当前不可用"}</strong>只提炼节奏、构图、运镜、色彩、转场和声音结构；开工后原片作为私密运行输入留档，不进入发布包，分析结果可预览和编辑。</span></p>
              {referenceError ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{referenceError}</p> : null}
            </section>

            <section className="recipe-section" aria-labelledby="recipe-section-title" data-tour="production-recipes">
              <div className="compact-section-heading">
                <div><span>03</span><h3 id="recipe-section-title">成本策略</h3></div>
                <small>只约束预算，不规定素材组合</small>
              </div>
              <fieldset className="recipe-options">
                <legend className="sr-only">制作配方</legend>
                {RECIPES.map((recipe) => {
                  const available = recipeAvailable(recipe, providers) && (!imageStory || recipe.maxPaidShots === 0);
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
                              {providerBillingLabel(provider)}
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
                    const baselineId = requiredFreeBaselineId(assetProviderIds, providers);
                    const disabled = !provider.available
                      || (provider.billing === "metered" && maxPaidShots === 0)
                      || (checked && provider.id === baselineId)
                      || (checked && assetProviderIds.length === 1);
                    return <label key={provider.id} className={checked ? "asset-source-option is-selected" : "asset-source-option"}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAssetProvider(provider)}
                      />
                      <span><strong>{provider.label}</strong><small>{provider.description ?? provider.id}</small></span>
                      <em>{providerBillingLabel(provider)}</em>
                    </label>;
                  })}
                </div>
                {selectedAssetSources.some((provider) => provider.modelProfiles?.length) ? <div className="asset-model-overrides" aria-label="本次生成模型">
                  <div><strong>本次模型</strong><small>只覆盖这条制作，总配置不会被修改</small></div>
                  {selectedAssetSources.filter((provider) => provider.modelProfiles?.length).map((provider) => <label className="field" key={provider.id}>
                    <span>{provider.label}</span>
                    <select aria-label={`${provider.label} 本次模型`} value={modelSelections[provider.id] ?? ""} onChange={(event) => setModelSelections((current) => {
                      const next = { ...current };
                      if (event.target.value) next[provider.id] = event.target.value;
                      else delete next[provider.id];
                      return next;
                    })}>
                      <option value="">继承默认：{effectiveModelId(provider) ?? "自动选择"}</option>
                      {provider.modelProfiles?.filter((model) => model.available).map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                    </select>
                    <small>{provider.modelProfiles?.find((model) => model.id === effectiveModelId(provider))?.description}</small>
                  </label>)}
                </div> : null}
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
              <label className={effectiveSemanticRank ? "visual-review-control is-enabled" : "visual-review-control"}>
                <input type="checkbox" checked={effectiveSemanticRank} disabled={!semanticRankCompatible} onChange={(event) => setSemanticRankEnabled(event.target.checked)} />
                <span><Sparkles aria-hidden="true" size={17} /><strong>候选语义选片</strong></span>
                <small>{semanticRankCompatible ? "先预览图库候选并给出逐镜排序；失败时保留素材源原顺序，下载前仍可人工调整" : "需要先启用 AI 视觉导演与逐镜路由"}</small>
              </label>
              <label className={visualReviewEnabled ? "visual-review-control is-enabled" : "visual-review-control"}>
                <input
                  type="checkbox"
                  checked={visualReviewEnabled && Boolean(visualReviewProvider)}
                  disabled={!visualReviewProvider}
                  onChange={(event) => {
                    setVisualReviewEnabled(event.target.checked);
                    if (event.target.checked && visualReviewProvider) {
                      setBindings((current) => ({ ...current, visualReview: visualReviewProvider.id }));
                    }
                  }}
                />
                <span><ScanSearch aria-hidden="true" size={17} /><strong>视觉审片</strong></span>
                <small>{visualReviewProvider
                  ? `${visualReviewProvider.label} · 抽帧审查，不上传音轨`
                  : "ZAI Codex broker 尚未接通，本次跳过视觉模型审片"}</small>
              </label>
              <div className="segmented-control review-control" aria-label="终审模式"><span>人工终审</span><small>发布前必须由你完整审片并批准</small></div>
              <label className="budget-control">
                <span><CircleDollarSign aria-hidden="true" size={16} /><strong>生成预算上限</strong></span>
                <span className="budget-input"><span>¥</span><input aria-label="预计成本上限" type="number" min={minimumBudget} step="0.1" value={displayedBudget} disabled={!meteredSelected} onChange={(event) => setBudgetCny(Number(event.target.value))} /></span>
                <small>{meteredSelected
                  ? `最多 ${maxPaidShots} 个计费镜头，生成最低 ¥${formatMoney(minimumBudget)}${meteredVoiceProvider ? `；配音约 ¥${formatMoney(voiceEstimate)}` : ""}${meteredVisualReview ? `；审片约 ¥${formatMoney(visualReviewEstimate)}` : ""}，按量节点执行前分别确认`
                  : meteredVoiceProvider || meteredVisualReview
                    ? `${meteredVoiceProvider ? `配音预计 ¥${formatMoney(voiceEstimate)}` : ""}${meteredVoiceProvider && meteredVisualReview ? "；" : ""}${meteredVisualReview ? `视觉审片预计 ¥${formatMoney(visualReviewEstimate)}` : ""}，执行前分别确认`
                    : "当前配方不会主动调用计费 API"}</small>
              </label>
            </section>

            {missingCapabilities.length > 0 ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />缺少正式生产能力：{missingCapabilities.map((item) => item.label).join("、")}。请先在素材与模型中完成配置。</p> : null}
            {error ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          </div>

          <footer className="dialog-actions recipe-dialog-actions">
            <div><strong>{RECIPES.find((recipe) => recipe.id === recipeId)?.label}</strong><span>{hasMeteredCalls ? `当前预计 ¥${formatMoney(displayedTotalEstimate)}` : "无按量 API 扣费"}</span></div>
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="submit" disabled={submitting || referenceUploading || !templatesLoaded || missingCapabilities.length > 0} data-tour="production-start">
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
  const profileId = providers.some((provider) => provider.id === "minimax-tts-v1" && provider.available)
    ? "minimax:Chinese (Mandarin)_News_Anchor"
    : "macos:Tingting";
  return {
    profileId,
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
  if (profileId.startsWith("tone:")) return "ffmpeg-tone-test-v1";
  if (profileId.startsWith("kokoro:")) return "kokoro-local-v1";
  if (profileId.startsWith("minimax:")) return "minimax-tts-v1";
  return "macos-say-v1";
}

function estimatedRecipeBudget(
  recipe: (typeof RECIPES)[number],
  assetProviderIds: string[],
  providers: StudioProvider[],
): number {
  const price = Math.max(...providers
    .filter((provider) => assetProviderIds.includes(provider.id) && provider.billing === "metered" && provider.estimatedCnyPerClip)
    .map((provider) => provider.estimatedCnyPerClip!));
  return Number.isFinite(price) ? roundMoney(price * recipe.maxPaidShots) : 0;
}

function selectedModelEstimate(provider: StudioProvider, modelId: string | undefined): number | undefined {
  if (!modelId) return provider.estimatedCnyPerClip;
  return provider.modelProfiles?.find((model) => model.id === modelId)?.estimatedCnyPerClip;
}

function recipeAvailable(recipe: (typeof RECIPES)[number], providers: StudioProvider[]): boolean {
  const foundationReady = providers.some((provider) => provider.id === "api-visual-director-v1" && provider.available)
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
  if (preferredId && providers.some((provider) => provider.id === preferredId && provider.available && isAssetSource(provider)) && !free.includes(preferredId)) {
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

function requiredFreeBaselineId(assetProviderIds: string[], providers: StudioProvider[]): string | undefined {
  const hasMeteredSource = providers.some((provider) => {
    return assetProviderIds.includes(provider.id) && provider.billing === "metered";
  });
  if (!hasMeteredSource) return undefined;
  const selectedFreeSources = providers.filter((provider) => {
    return assetProviderIds.includes(provider.id) && provider.available && isAssetSource(provider) && provider.billing !== "metered";
  });
  return selectedFreeSources.find((provider) => provider.id === "local-editorial-v1")?.id
    ?? selectedFreeSources[0]?.id;
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function providerBillingLabel(provider: StudioProvider): string {
  if (provider.billing === "subscription") return "订阅额度";
  if (provider.billing !== "metered") return "免费";
  const unit = provider.billingUnit === "run" ? "次" : "镜头";
  return provider.estimatedCnyPerClip === undefined
    ? "待估价"
    : `约 ¥${formatMoney(provider.estimatedCnyPerClip)}/${unit}`;
}
