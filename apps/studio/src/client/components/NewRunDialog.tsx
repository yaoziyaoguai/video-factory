import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  FileText,
  Film,
  Image,
  Mic2,
  RefreshCw,
  ScanSearch,
  Sparkles,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { StudioCreatorSettings, StudioProductionInput, StudioProvider, StudioReferenceVideo, StudioReworkDraft, StudioReworkFinding, StudioTemplate } from "../../shared/api.js";
import { STUDIO_DIRECTOR_PROFILES, type StudioDirectorProfileId } from "../../shared/director-profiles.js";
import { selectableModelsForCapability } from "../../shared/model-compatibility.js";
import { applyTemplateVoiceRecommendation } from "../../shared/template-voice-recommendation.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { VoiceStudio } from "./VoiceStudio.js";
import { studioApi } from "../api.js";
import { creatorFacingTechnicalText, providerLabel } from "../presentation.js";
import { TemplateGallery } from "../templates/TemplateGallery.js";

interface NewRunDialogProps {
  open: boolean;
  providers: StudioProvider[];
  initialDataReady?: boolean;
  initialValues?: Partial<StudioProductionInput>;
  inheritedNodeIds?: StudioReworkDraft["inheritedNodeIds"];
  requiredAffectedScenePositions?: StudioReworkDraft["requiredAffectedScenePositions"];
  creatorSettings?: StudioCreatorSettings;
  settingsError?: string;
  onRetrySettings?: () => void;
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

interface InheritedSelectionIssue {
  id: string;
  label: string;
  value: string;
  reason: string;
  action: string;
}

const CAPABILITIES: CapabilityDefinition[] = [
  { key: "script", capability: "script.draft", label: "脚本生成", role: "编剧", description: "结构、钩子与分镜文案", preferred: "codex-screenwriter-v1", icon: FileText },
  { key: "director", capability: "storyboard.plan", label: "导演方案", role: "导演", description: "统一全片视觉规则并逐镜决定画面", preferred: "api-visual-director-v1", icon: Clapperboard },
  { key: "assets", capability: "asset.prepare", label: "画面素材", role: "素材导演", description: "按导演方案逐镜寻找或生成画面", preferred: "ai-shot-router-v1", icon: Image },
  { key: "voice", capability: "voice.synthesize", label: "配音", role: "声音导演", description: "旁白音色与语速", preferred: "macos-say-v1", icon: Mic2 },
  { key: "render", capability: "video.render", label: "视频渲染", role: "剪辑师", description: "9:16 合成、字幕与音轨", preferred: "python-ffmpeg-v1", icon: Film },
  { key: "technicalReview", capability: "quality.review", label: "机器质检", role: "技术质检", description: "分辨率、时长与产物校验", preferred: "python-technical-review-v1", icon: ScanSearch },
  { key: "visualReview", capability: "quality.review.visual", label: "视觉审片", role: "视觉审片员", description: "构图、连续性、节奏与文字可读性", preferred: "glm-visual-review-v1", icon: ScanSearch, optional: true },
];

const RECIPES: Array<{
  id: RecipeId;
  label: string;
  description: string;
  allowMeteredProviders: boolean;
  recommended?: boolean;
}> = [
  {
    id: "free-stock",
    label: "仅免费画面",
    description: "导演只使用已启用的免费图库或你主动允许的本地编辑画面",
    allowMeteredProviders: false,
    recommended: true,
  },
  {
    id: "keyshot-ai",
    label: "允许付费关键镜头",
    description: "导演可建议生成关键图片或视频，每次调用前都会给出报价并等你确认",
    allowMeteredProviders: true,
  },
];

const PRODUCTION_PLATFORMS = ["douyin", "xiaohongshu", "bilibili"] as const;

function isProductionPlatform(value: string | undefined): value is typeof PRODUCTION_PLATFORMS[number] {
  return PRODUCTION_PLATFORMS.some((platform) => platform === value);
}

function canonicalRecipeId(recipeId: RecipeId | undefined): RecipeId {
  return recipeId === "keyshot-ai" || recipeId === "cinematic-ai" ? "keyshot-ai" : "free-stock";
}

export function NewRunDialog({ open, providers, initialDataReady = true, initialValues, inheritedNodeIds, requiredAffectedScenePositions, creatorSettings, settingsError, onRetrySettings, onClose, onSubmit }: NewRunDialogProps) {
  const defaults = useMemo(
    () => providerDefaults(providers, creatorSettings?.roleProviderDefaults),
    [creatorSettings?.roleProviderDefaults, providers],
  );
  const [bindings, setBindings] = useState<StudioProductionInput["providers"]>(defaults);
  const effectiveBindings = useMemo(
    () => initialValues?.rework ? bindings : availableProviderBindings(bindings, defaults, providers),
    [bindings, defaults, initialValues?.rework, providers],
  );
  const [activeKey, setActiveKey] = useState<BindingKey>("assets");
  const [recipeId, setRecipeId] = useState<RecipeId>("free-stock");
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
  const voiceTouched = useRef(false);
  const templateAddedEditorialSource = useRef(false);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const assetSourcePoolRef = useRef<HTMLElement>(null);
  const scrollToAssetSourcesOnOpen = useRef(false);
  const initialScrollResetPending = useRef(false);
  const [referenceUploading, setReferenceUploading] = useState(false);
  const [referenceError, setReferenceError] = useState<string>();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [inheritedSettingsOpen, setInheritedSettingsOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [templates, setTemplates] = useState<StudioTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState(
    initialValues?.template?.templateId
      ?? (initialValues?.editorial?.verdict === "produce_image_story"
        ? "photo-story"
        : initialValues?.editorial ? "" : "knowledge-explainer"),
  );
  const [templateReplacementConfirmed, setTemplateReplacementConfirmed] = useState(false);
  const [templateError, setTemplateError] = useState<string>();
  const [voiceSelectionAvailable, setVoiceSelectionAvailable] = useState<boolean>();
  const [rework, setRework] = useState<StudioProductionInput["rework"]>(() => creatorFacingRework(
    initialValues?.rework,
    requiredAffectedScenePositions,
  ));
  const initializedForOpen = useRef(false);
  const initializationRevision = useRef(0);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose, submitting);
  const activeCapability = CAPABILITIES.find((item) => item.key === activeKey) ?? CAPABILITIES[1]!;
  const groupedReworkFindings = useMemo(() => groupReworkFindingsByScene(rework?.findings), [rework?.findings]);
  const reworkScope = useMemo(() => summarizeReworkScope(rework), [rework]);
  const requiredReworkScenePositions = useMemo(() => requiredScenePositionsForRework(
    initialValues?.rework,
    requiredAffectedScenePositions,
  ), [initialValues?.rework, requiredAffectedScenePositions]);
  const reworkTargetStepLabels = useMemo(() => reworkFindingTargetStepLabels(groupedReworkFindings), [groupedReworkFindings]);
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
  const selectedRecipe = RECIPES.find((recipe) => recipe.id === recipeId) ?? RECIPES[0]!;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId);
  const templateSelectionMissing = templatesLoaded && !selectedTemplate;
  const inheritedTemplateAvailable = !initialValues?.rework || !initialValues.template
    || templates.some((template) => (
      template.id === initialValues.template?.templateId
      && template.status === "published"
    ));
  const effectiveModelId = (provider: StudioProvider) => modelSelections[provider.id]
    ?? selectedTemplate?.modelDefaults?.[provider.id]
    ?? provider.defaultModelId;
  const visualReviewProvider = providers.find((provider) => {
    return provider.capability === "quality.review.visual" && provider.id === effectiveBindings.visualReview && provider.available;
  }) ?? providers.find((provider) => provider.capability === "quality.review.visual" && provider.available);
  const inheritedVisualReviewUnavailable = Boolean(initialValues?.rework && bindings.visualReview && !providers.some((provider) => (
    provider.id === bindings.visualReview
    && provider.capability === "quality.review.visual"
    && provider.available
    && provider.kind !== "test"
  )));
  const referenceGrammarProvider = providers.find((provider) => {
    return provider.id === "codex-reference-grammar-v1" && provider.capability === "reference.grammar" && provider.available;
  });
  const roleAuditProvider = providers.find((provider) => {
    return provider.id === "codex-role-auditor-v1" && provider.capability === "role.audit" && provider.available;
  });
  const semanticRankCompatible = Boolean(effectiveBindings.director && effectiveBindings.assets === "ai-shot-router-v1");
  const effectiveSemanticRank = semanticRankCompatible && semanticRankEnabled;
  const meteredSelected = selectedMeteredSources.length > 0 && selectedRecipe.allowMeteredProviders;
  const visualReviewRequired = meteredSelected;
  const effectiveVisualReviewEnabled = visualReviewRequired || visualReviewEnabled;
  const subscriptionVisualReview = effectiveVisualReviewEnabled && visualReviewProvider?.billing === "subscription"
    ? visualReviewProvider
    : undefined;
  const automaticVoiceProvider = providers.find((provider) => {
    return provider.capability === "voice.synthesize"
      && provider.id === effectiveBindings.voice
      && provider.available
      && provider.billing === "metered"
      && provider.approvalPolicy === "automatic";
  });
  const hasMeteredCalls = meteredSelected || automaticVoiceProvider !== undefined;
  const economics: StudioProductionInput["economics"] = {
    recipeId,
    allowMeteredProviders: hasMeteredCalls,
  };
  const inheritedSelectionIssues = useMemo<InheritedSelectionIssue[]>(() => {
    if (!initialValues?.rework) return [];
    const issues: InheritedSelectionIssue[] = [];
    if (templatesLoaded && (
      !templates.some((template) => template.id === selectedTemplateId && template.status === "published")
      || (!templateReplacementConfirmed && !inheritedTemplateAvailable)
    )) {
      issues.push({
        id: "template",
        label: "视频模板",
        value: initialValues.template?.templateVersion === undefined
          ? "上一版模板"
          : `上一版模板 v${initialValues.template.templateVersion}`,
        reason: "上一版模板或对应版本当前已不是可用的正式模板",
        action: "请在视频模板中明确选择替代模板",
      });
    }
    for (const item of CAPABILITIES) {
      const providerId = bindings[item.key];
      if (!providerId && item.optional) continue;
      const provider = providers.find((candidate) => candidate.id === providerId);
      const reason = !provider
        ? "当前能力目录中已不存在"
        : provider.capability !== item.capability
          ? `现在用于${productionStepLabel(provider.capability)}，不能继续作为${item.role}`
          : provider.kind === "test"
            ? "仅供测试，不能用于正式制作"
            : !provider.available
              ? creatorFacingTechnicalText(provider.requirement) ?? "当前未配置或暂不可用"
              : undefined;
      if (reason) {
        issues.push({
          id: `provider-${item.key}`,
          label: `${item.role}能力`,
          value: provider ? creatorProviderName(provider) : "上一版选择",
          reason,
          action: item.key === "voice" ? "请在声音导演中明确选择可用声音" : `请在${item.role}能力中明确选择替代项`,
        });
      }
    }
    for (const providerId of assetProviderIds) {
      const provider = providers.find((candidate) => candidate.id === providerId);
      const reason = !provider
        ? "当前画面来源目录中已不存在"
        : !isAssetSource(provider)
          ? "现在不能作为画面来源"
          : !provider.available
            ? creatorFacingTechnicalText(provider.requirement) ?? "当前未配置或暂不可用"
            : provider.billing === "metered" && !selectedRecipe.allowMeteredProviders
              ? "当前选择的是仅免费画面策略"
              : undefined;
      if (reason) {
        issues.push({
          id: `source-${providerId}`,
          label: "画面来源",
          value: provider ? creatorProviderName(provider) : "上一版画面来源",
          reason,
          action: "请调整画面来源，或重新选择允许付费关键镜头",
        });
      }
    }
    const selectedProviderIds = new Set([
      ...Object.values(bindings).filter((providerId): providerId is string => Boolean(providerId)),
      ...assetProviderIds,
    ]);
    for (const [providerId, modelId] of Object.entries(modelSelections)) {
      if (!selectedProviderIds.has(providerId)) continue;
      const provider = providers.find((candidate) => candidate.id === providerId);
      if (!provider?.available) continue;
      const model = provider.modelProfiles?.find((candidate) => candidate.id === modelId);
      if (!model || !selectableModelsForCapability([model], provider.capability).length) {
        issues.push({
          id: `model-${providerId}`,
          label: `${creatorProviderName(provider)} 模型`,
          value: model?.label ?? "上一版模型",
          reason: !model ? "当前模型目录中已不存在" : "当前不可用或不再兼容这个制作步骤",
          action: "请明确选择可用模型，或改为继承当前推荐模型",
        });
      }
    }
    if (voiceSelectionAvailable === false) {
      issues.push({
        id: "voice-profile",
        label: "声音演员",
        value: "上一版声音演员",
        reason: "当前声音演员目录中已不存在或暂不可用",
        action: "请在声音导演中明确选择替代声音",
      });
    }
    return issues;
  }, [assetProviderIds, bindings, inheritedTemplateAvailable, initialValues?.rework, initialValues?.template?.templateVersion, modelSelections, providers, selectedRecipe.allowMeteredProviders, selectedTemplateId, templateReplacementConfirmed, templates, templatesLoaded, voiceDirection.profileId, voiceSelectionAvailable]);
  const missingCapabilities = CAPABILITIES.filter((item) => {
    return !item.optional
      && !providers.some((provider) => provider.capability === item.capability && provider.available && provider.kind !== "test");
  });
  const missingProductionRoles = [
    ...missingCapabilities.map((item) => item.label),
    ...(assetProviderIds.length > 0 ? [] : ["导演画面来源"]),
    ...(roleAuditProvider ? [] : ["独立质量复核"]),
    ...(voiceSelectionAvailable === false && !initialValues?.rework ? ["可用声音演员"] : []),
  ];
  // 链接按现有分区优先：制作角色能力缺口落到制作分工；只剩画面来源缺口时落到画面来源分区，避免让创作者自己找。
  const capabilitySettingsHref = missingCapabilities.length > 0 || !roleAuditProvider
    || (voiceSelectionAvailable === false && !initialValues?.rework)
    ? "/resources#production-roles"
    : "/resources#visual-providers";
  const productionBlocked = missingProductionRoles.length > 0 || inheritedSelectionIssues.length > 0 || templateSelectionMissing;

  async function readTemplateCatalog(revision: number, requestedTemplateId: string, preserveCurrentChoices: boolean) {
    setTemplateLoading(true);
    setTemplateError(undefined);
    try {
      const catalog = await studioApi.templates();
      if (initializationRevision.current !== revision) return;
      const published = (catalog.productionTemplates ?? catalog.templates).filter((template) => template.status === "published");
      const availableTemplates = published;
      if (availableTemplates.length === 0) throw new Error("模板目录中没有可用模板。");
      setTemplates(availableTemplates);
      if (initialValues?.rework) {
        setSelectedTemplateId(requestedTemplateId);
      } else {
        const resolvedTemplate = availableTemplates.find((template) => template.id === requestedTemplateId);
        setSelectedTemplateId(resolvedTemplate?.id ?? "");
        if (resolvedTemplate && !preserveCurrentChoices && !initialValues?.voiceDirection && !creatorVoiceWasCustomized(creatorSettings) && !voiceTouched.current) {
          setVoiceDirection((current) => applyTemplateVoiceRecommendation(resolvedTemplate, current));
        }
      }
      setTemplatesLoaded(true);
    } catch (caught) {
      if (initializationRevision.current !== revision) return;
      setTemplatesLoaded(false);
      setTemplateError(`无法读取模板目录：${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      if (initializationRevision.current === revision) setTemplateLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      initializedForOpen.current = false;
      initializationRevision.current += 1;
      initialScrollResetPending.current = false;
      setAdvancedOpen(false);
      setInheritedSettingsOpen(false);
      setTemplates([]);
      setTemplatesLoaded(false);
      setTemplateLoading(false);
      setTemplateError(undefined);
      return;
    }
    if (!initialDataReady) return;
    if (initializedForOpen.current) return;
    initializedForOpen.current = true;
    initialScrollResetPending.current = true;
    if (formScrollRef.current) formScrollRef.current.scrollTop = 0;
    voiceTouched.current = false;
    const revision = ++initializationRevision.current;
    const initialVoiceDirection = initialValues?.voiceDirection ?? creatorSettings?.voiceDirection ?? defaultVoiceDirection(providers);
    const requestedVoiceProvider = providerForVoiceProfile(initialVoiceDirection.profileId);
    const readyVoiceProvider = providers.find((provider) => {
      return provider.id === requestedVoiceProvider && provider.capability === "voice.synthesize" && provider.available && provider.kind !== "test";
    });
    const resolvedVoiceDirection = readyVoiceProvider || initialValues?.rework ? initialVoiceDirection : defaultVoiceDirection(providers);
    const initialBindings = {
      ...defaults,
      ...(initialValues?.providers ?? {}),
      assets: initialValues?.rework ? initialValues.providers?.assets ?? defaults.assets : "ai-shot-router-v1",
      voice: initialValues?.rework
        ? initialValues.providers?.voice ?? requestedVoiceProvider
        : providerForVoiceProfile(resolvedVoiceDirection.profileId),
    };
    const initialRecipe = canonicalRecipeId(imageStory && !initialValues?.rework
      ? "free-stock"
      : initialValues?.economics?.recipeId ?? creatorSettings?.defaultRecipeId);
    const recipe = RECIPES.find((item) => item.id === initialRecipe) ?? RECIPES[0]!;
    const initialProfile = initialValues?.director?.profileId ?? creatorSettings?.productionDefaults?.directorProfileId ?? "auto";
    const requestedTemplateId = initialValues?.template?.templateId
      ?? (imageStory ? "photo-story" : initialValues?.editorial ? "" : "knowledge-explainer");
    const inheritedOrRecommendedSourceIds = initialValues?.director?.assetProviderIds
      ?? sourceIdsForRecipe(recipe, providers, creatorSettings?.defaultAssetProviderId);
    const sourceIds = requestedTemplateId === "photo-story"
      ? includeLocalEditorialSource(inheritedOrRecommendedSourceIds, providers)
      : inheritedOrRecommendedSourceIds;
    setBindings(initialBindings);
    setRecipeId(recipe.id);
    setDirectorProfileId(initialProfile);
    const initialPlatform = initialValues?.platform ?? creatorSettings?.productionDefaults?.platform ?? "douyin";
    setPlatform(isProductionPlatform(initialPlatform) ? initialPlatform : "");
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
    scrollToAssetSourcesOnOpen.current = false;
    setInheritedSettingsOpen(false);
    setError(undefined);
    setSelectedTemplateId(requestedTemplateId);
    setTemplateError(undefined);
    setTemplateLoading(false);
    setVoiceSelectionAvailable(undefined);
    setRework(creatorFacingRework(initialValues?.rework, requiredAffectedScenePositions));
    setTemplateReplacementConfirmed(false);
    templateAddedEditorialSource.current = requestedTemplateId === "photo-story"
      && !inheritedOrRecommendedSourceIds.includes("local-editorial-v1")
      && sourceIds.includes("local-editorial-v1");
    setTemplates([]);
    setTemplatesLoaded(false);
    void readTemplateCatalog(revision, requestedTemplateId, false);
  }, [creatorSettings, defaults, imageStory, initialDataReady, initialValues, open, providers, requiredAffectedScenePositions]);

  useLayoutEffect(() => {
    if (!open || !initialScrollResetPending.current || (!templatesLoaded && !templateError)) return;
    if (formScrollRef.current) formScrollRef.current.scrollTop = 0;
    initialScrollResetPending.current = false;
  }, [open, templateError, templatesLoaded]);

  useEffect(() => {
    if (!open || !advancedOpen || !inheritedSettingsOpen || !scrollToAssetSourcesOnOpen.current) return;
    scrollToAssetSourcesOnOpen.current = false;
    const sourcePool = assetSourcePoolRef.current;
    if (typeof sourcePool?.scrollIntoView === "function") sourcePool.scrollIntoView({ block: "nearest" });
  }, [advancedOpen, inheritedSettingsOpen, open]);

  useEffect(() => {
    if (!open || !referenceVideo) return;
    const uploadId = referenceVideo.uploadId;
    return () => {
      if (releasedReferenceId.current !== uploadId) void studioApi.deleteReferenceVideo(uploadId).catch(() => undefined);
    };
  }, [open, referenceVideo]);

  if (!open) return null;

  if (!initialDataReady && !initializedForOpen.current) {
    // 设置读取失败与仍在加载是两种不同状态：失败时允许打开查看原因并原地重读，但表单不初始化、不能提交。
    const settingsFailed = Boolean(settingsError);
    return (
      <div className="dialog-backdrop" role="presentation">
        <section ref={dialogRef} className="run-dialog recipe-dialog" role="dialog" aria-modal="true" aria-labelledby="new-run-loading-title" aria-busy={settingsFailed ? undefined : "true"} tabIndex={-1}>
          <header className="dialog-header recipe-dialog-header">
            <div>
              <p className="eyebrow">制作方案</p>
              <h2 id="new-run-loading-title">{settingsFailed ? "创作设置读取失败" : "正在准备新制作"}</h2>
            </div>
            <button className="icon-button" type="button" onClick={onClose} title="关闭" aria-label="关闭新建制作">
              <X aria-hidden="true" size={19} />
            </button>
          </header>
          {settingsFailed ? (
            <div className="page-error" role="alert">
              <AlertCircle aria-hidden="true" size={18} />
              <span>未能读取你的创作设置，为避免用错声音/平台/时长，暂未开工。{settingsError}</span>
              {onRetrySettings ? <button className="button button-secondary" type="button" onClick={onRetrySettings}><RefreshCw aria-hidden="true" size={16} />重新读取</button> : null}
            </div>
          ) : <div className="page-loading">正在读取制作配置...</div>}
        </section>
      </div>
    );
  }

  function applyRecipe(nextId: RecipeId) {
    const recipe = RECIPES.find((item) => item.id === nextId) ?? RECIPES[0]!;
    if (imageStory && recipe.allowMeteredProviders) return;
    const baseSourceIds = sourceIdsForRecipe(recipe, providers);
    const sourceIds = selectedTemplateId === "photo-story"
      ? includeLocalEditorialSource(baseSourceIds, providers)
      : baseSourceIds;
    templateAddedEditorialSource.current = selectedTemplateId === "photo-story"
      && !baseSourceIds.includes("local-editorial-v1")
      && sourceIds.includes("local-editorial-v1");
    setRecipeId(nextId);
    setBindings((current) => ({ ...current, assets: "ai-shot-router-v1" }));
    setAssetProviderIds(sourceIds);
    setActiveKey("assets");
  }

  function selectProvider(provider: StudioProvider) {
    if (!provider.available) return;
    setBindings((current) => ({ ...current, [activeKey]: provider.id }));
    if (activeKey === "visualReview") setVisualReviewEnabled(true);
  }

  function disableInheritedVisualReview() {
    setVisualReviewEnabled(false);
    setBindings((current) => {
      const next = { ...current };
      delete next.visualReview;
      return next;
    });
  }

  function openAssetSourceControls() {
    if (advancedOpen && inheritedSettingsOpen) {
      scrollToAssetSourcesOnOpen.current = false;
      assetSourcePoolRef.current?.scrollIntoView?.({ block: "nearest" });
    } else {
      scrollToAssetSourcesOnOpen.current = true;
    }
    setInheritedSettingsOpen(true);
    setAdvancedOpen(true);
    setActiveKey("assets");
  }

  function toggleAssetSourceControls() {
    if (advancedOpen) {
      scrollToAssetSourcesOnOpen.current = false;
      setAdvancedOpen(false);
      return;
    }
    openAssetSourceControls();
  }

  function selectTemplate(template: StudioTemplate) {
    setSelectedTemplateId(template.id);
    setTemplateReplacementConfirmed(Boolean(initialValues?.rework));
    setDurationSeconds(template.durationSeconds);
    setAssetProviderIds((current) => {
      if (template.id === "photo-story") {
        const next = includeLocalEditorialSource(current, providers);
        templateAddedEditorialSource.current = !current.includes("local-editorial-v1") && next.includes("local-editorial-v1");
        return next;
      }
      if (templateAddedEditorialSource.current) {
        templateAddedEditorialSource.current = false;
        return current.filter((id) => id !== "local-editorial-v1");
      }
      return current;
    });
    if (!initialValues?.rework && !initialValues?.voiceDirection && !creatorVoiceWasCustomized(creatorSettings) && !voiceTouched.current) {
      setVoiceDirection((current) => applyTemplateVoiceRecommendation(template, current));
    }
  }

  function toggleAssetProvider(provider: StudioProvider) {
    if (!provider.available || (provider.billing === "metered" && !selectedRecipe.allowMeteredProviders)) return;
    if (provider.id === "local-editorial-v1" && selectedTemplateId === "photo-story") return;
    setAssetProviderIds((current) => {
      if (current.includes(provider.id)) {
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

  async function submit(form: HTMLFormElement) {
    if (submitting) return;
    const data = new FormData(form);
    setSubmitting(true);
    setError(undefined);
    try {
      if (inheritedSelectionIssues.length > 0) {
        throw new Error("上一版仍有失效配置，请明确选择替代项后再开始制作。");
      }
      if (!isProductionPlatform(platform)) {
        throw new Error("请选择目标平台后再开始制作。");
      }
      if (!templatesLoaded || !templates.some((template) => template.id === selectedTemplateId && template.status === "published")) {
        throw new Error(templateError ?? "模板目录尚未加载完成，请稍后重试。");
      }
      if (visualReviewRequired && !visualReviewProvider) {
        throw new Error("付费图片和视频必须先启用可用的视觉审片；请检查视觉审片服务，或改用免费画面来源。");
      }
      const selectedTemplate = templates.find((template) => template.id === selectedTemplateId)!;
      const providersForRun: StudioProductionInput["providers"] = { ...effectiveBindings };
      if (effectiveVisualReviewEnabled && visualReviewProvider) providersForRun.visualReview = visualReviewProvider.id;
      else delete providersForRun.visualReview;
      const selectedProviderIds = new Set([
        ...Object.values(providersForRun).filter((providerId): providerId is string => Boolean(providerId)),
        ...assetProviderIds,
      ]);
      const modelsForRun = Object.fromEntries(Object.entries(modelSelections).filter(([providerId, modelId]) => {
        return selectedProviderIds.has(providerId) && Boolean(modelId);
      }));
      await onSubmit({
        protocolVersion: "video-factory/brief-v1",
        title: requiredString(data, "title"),
        angle: requiredString(data, "angle"),
        audience: requiredString(data, "audience"),
        nicheSlug: initialValues?.nicheSlug ?? topicSlug(requiredString(data, "title")),
        durationSeconds,
        platform,
        reviewMode: "manual",
        runPurpose: initialValues?.runPurpose ?? "production",
        ...(editorial ? { editorial } : {}),
        ...(initialValues?.visualProof ? { visualProof: initialValues.visualProof } : {}),
        ...(initialValues?.visualPlan ? { visualPlan: initialValues.visualPlan } : {}),
        ...(initialValues?.seriesContext ? { seriesContext: initialValues.seriesContext } : {}),
        ...(initialValues?.creationContext ? { creationContext: initialValues.creationContext } : {}),
        ...(rework ? { rework } : {}),
        voiceDirection,
        template: {
          templateId: selectedTemplateId,
          ...(initialValues?.template?.templateId === selectedTemplateId
            && initialValues.template.templateVersion !== undefined
            && !templateReplacementConfirmed
            && inheritedTemplateAvailable
            ? { templateVersion: initialValues.template.templateVersion }
            : {}),
          runOverrides: {
            durationSeconds,
            ...(initialValues?.template?.templateId === selectedTemplateId
              && initialValues.template.templateVersion !== undefined
              && !templateReplacementConfirmed
              && inheritedTemplateAvailable
              ? {}
              : { automationLevel: selectedTemplate.automationLevel }),
          },
        },
        providers: providersForRun,
        models: modelsForRun,
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
            <h2 id="new-run-title">{rework ? "调整方案后重新制作" : "新建制作"}</h2>
            <p>{rework ? "已载入上一版可用设置；真实母片复用与最终方案仍需重新规划验证。下面的修改要求会真正交给对应制作步骤执行。" : "先定内容与画面方案；图片和视频按实际方案报价。声音与审片不弹现金报价，但失败或质量问题会停在对应步骤。"}</p>
          </div>
          <div className="dialog-budget" aria-label="费用方式">
            <span>{meteredSelected ? "图片 / 视频按实际方案报价" : "图片 / 视频无现金报价"}</span>
            <strong>{meteredSelected ? "逐项人工确认" : "无需现金确认"}</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={submitting} title="关闭" aria-label="关闭新建制作">
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        <form className="run-form recipe-form" onSubmit={(event) => event.preventDefault()} key={initialValues?.title ?? "blank-production"}>
          <div ref={formScrollRef} className="recipe-form-scroll" style={{ overflowAnchor: "none" }}>
            {rework ? <section className="rework-brief-section" aria-labelledby="rework-scope-title" tabIndex={-1} data-dialog-initial-focus>
              <div className="compact-section-heading">
                <div><span>返工</span><h3 id="rework-scope-title">本轮变更范围</h3></div>
                <small>先确认重做镜头，再填写怎么改</small>
              </div>
              {reworkScope?.fullScenePositions ? <>
                <p className="rework-scope-guidance" id="rework-scope-guidance">勾选决定哪些镜头进入本轮画面重新规划与生成，并直接影响图片 / 视频报价。审片或失败记录明确要求的镜头标为必改，不能移除；下方文字只说明怎么改，不代替这里的镜头选择。</p>
                <fieldset className="rework-scene-scope" aria-describedby="rework-scope-guidance">
                  <legend className="sr-only">本轮要重新规划 / 生成的镜头</legend>
                  <strong>本轮要重新规划 / 生成的镜头</strong>
                  <div>{reworkScope.fullScenePositions.map((position) => {
                    const required = requiredReworkScenePositions.includes(position);
                    return (
                      <label className={required ? "is-required" : undefined} key={position}>
                        <input
                          type="checkbox"
                          aria-label={`第 ${position} 镜`}
                          checked={reworkScope.adjustedScenePositions.includes(position)}
                          disabled={required}
                          onChange={() => setRework((current) => toggleReworkScene(current, position))}
                        />
                        <span>第 {position} 镜</span>
                        {required ? <small aria-hidden="true">必改</small> : null}
                      </label>
                    );
                  })}</div>
                </fieldset>
                <div className="rework-finding-list" aria-label="本轮变更范围摘要">
                  <div className="rework-rejection-note"><strong>{reworkScope.adjustedScenePositions.length > 0
                    ? `本轮选择 ${reworkScope.adjustedScenePositions.length} 个镜头：${reworkScope.adjustedScenePositions.join("、")}`
                    : "本轮未选择需要重新规划 / 生成的镜头"}</strong></div>
                  {reworkScope.plannedReuseScenePositions.length > 0 ? <div className="rework-rejection-note"><strong>其余 {reworkScope.plannedReuseScenePositions.length} 个镜头计划沿用：{reworkScope.plannedReuseScenePositions.join("、")}</strong></div> : null}
                  <p className="rework-boundary-note">是否能直接复用上一版母片，以重新规划后的画面方案和真实报价为准。</p>
                </div>
              </> : <div className="rework-finding-list" aria-label="本轮变更范围摘要">
                <div className="rework-rejection-note"><strong>全片需复核；具体重做范围以重新规划后的方案为准。</strong></div>
                <p className="rework-boundary-note">上一版没有可验证的完整镜头全集，因此这里不会猜测镜头编号。重新规划确认范围后，再对实际需要生成的图片 / 视频报价。</p>
              </div>}
            </section> : null}
            {inheritedSelectionIssues.length > 0 ? <section className="rework-selection-alert" role="alert" aria-live="assertive" aria-labelledby="rework-selection-alert-title">
              <div>
                <AlertCircle aria-hidden="true" size={18} />
                <div><strong id="rework-selection-alert-title">上一版有 {inheritedSelectionIssues.length} 项已失效，暂不能开工</strong><span>系统保留了上一版原值，没有替你静默更换。请逐项明确选择替代方案。</span></div>
              </div>
              <ul>{inheritedSelectionIssues.map((issue) => <li key={issue.id}>
                <strong>{issue.label}：{issue.value}</strong>
                <span>{issue.reason}；{issue.action}</span>
              </li>)}</ul>
              {inheritedSelectionIssues.some((issue) => issue.id.startsWith("source-")) ? <button className="button button-ghost" type="button" onClick={() => {
                const sourceIds = sourceIdsForRecipe(selectedRecipe, providers);
                setAssetProviderIds(selectedTemplateId === "photo-story"
                  ? includeLocalEditorialSource(sourceIds, providers)
                  : sourceIds);
                openAssetSourceControls();
              }}>用当前策略的可用来源替换</button> : null}
            </section> : null}
            {rework ? <section className="rework-brief-section" aria-labelledby="rework-brief-title">
              <div className="compact-section-heading">
                <div><span>返工</span><h3 id="rework-brief-title">按反馈修改</h3></div>
                <small>已预填到对应制作步骤，可在开工前调整</small>
              </div>
              {rework.rejectionReason ? <div className="rework-rejection-note"><strong>本次重做原因</strong><span>{creatorFacingTechnicalText(rework.rejectionReason)}</span></div> : null}
              {groupedReworkFindings.sceneGroups.length > 0 || groupedReworkFindings.wholeFilmFindings.length > 0 ? <div className="rework-finding-list" aria-label="需要处理的问题">
                {groupedReworkFindings.sceneGroups.map((group) => <article className="rework-finding" key={`scene-${group.scenePosition}`}>
                  <header><strong>第 {group.scenePosition} 镜</strong><span>{group.findings.length} 个问题</span></header>
                  {group.findings.map((sceneFinding) => <div className="rework-finding-item" key={sceneFinding.findingId}>
                    <p>{reworkFindingCategoryLabel(sceneFinding.category)} · {formatTimecode(sceneFinding.timecodeMs)}</p>
                    <p>{creatorFacingTechnicalText(sceneFinding.description)}</p>
                    <small>建议：{creatorFacingTechnicalText(sceneFinding.suggestion)}</small>
                  </div>)}
                </article>)}
                {groupedReworkFindings.wholeFilmFindings.length > 0 ? <article className="rework-finding" key="rework-whole-film">
                  <header><strong>全片问题</strong><span>{groupedReworkFindings.wholeFilmFindings.length} 个问题</span></header>
                  {groupedReworkFindings.wholeFilmFindings.map((sceneFinding) => <div className="rework-finding-item" key={sceneFinding.findingId}>
                    <p>{reworkFindingCategoryLabel(sceneFinding.category)} · {formatTimecode(sceneFinding.timecodeMs)}</p>
                    <p>{creatorFacingTechnicalText(sceneFinding.description)}</p>
                    <small>建议：{creatorFacingTechnicalText(sceneFinding.suggestion)}</small>
                  </div>)}
                </article> : null}
              </div> : null}
              {reworkTargetStepLabels.length > 0 ? <p className="rework-boundary-note">审片反馈将预填到：{reworkTargetStepLabels.join("、")}。</p> : null}
              <div className="rework-instruction-grid">
                <label className="field">
                  <span>脚本修改要求</span>
                  <textarea required value={rework.nodeInstructions.script} onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, script: event.target.value } } : current)} />
                </label>
                <label className="field">
                  <span>导演方案修改要求</span>
                  <textarea required value={rework.nodeInstructions.visualDirection} onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, visualDirection: event.target.value } } : current)} />
                </label>
                <label className="field">
                  <span>画面素材修改要求</span>
                  <textarea required value={rework.nodeInstructions.assets} onChange={(event) => setRework((current) => current ? { ...current, nodeInstructions: { ...current.nodeInstructions, assets: event.target.value } } : current)} />
                </label>
              </div>
              <p className="rework-boundary-note">{reworkBaselineSummary(rework)}</p>
              <ul className="rework-boundary-note">
                <li>{rework.previousScript ? "脚本：以上一版脚本为修改基线，并按审片反馈调整。" : "脚本：上一版脚本未产出，本轮需要重新生成脚本。"}</li>
                <li>{rework.previousDirectorPlan ? "导演：以上一版导演方案为修改基线，按反馈复核所列镜头。" : "导演：上一版导演方案未产出，本轮需要重新规划画面方案。"}</li>
                {inheritedNodeIds?.includes("template") ? <li>模板：已带入上一版模板快照，可在继承设置中沿用或更换。</li> : null}
                <li>声音：声音设置已预填；脚本文字变化时，配音可能重新生成。</li>
                <li>报价：下一轮会对实际需要重新生成的图片和视频逐项报价；最终项目和金额以费用确认页为准。</li>
              </ul>
              {inheritedNodeIds && inheritedNodeIds.length > 0 ? <p className="rework-boundary-note">已带入上一版基线资料：{inheritedNodeIds.map((nodeId) => REWORK_BASELINE_NODE_LABELS[nodeId] ?? nodeId).join("、")}；这些资料用于对照和预填，不代表声音成品或素材母片已经复用，也不代表免费。</p> : null}
            </section> : null}
            {rework ? <div className={inheritedSettingsOpen ? "advanced-production is-open" : "advanced-production"}>
              <button className="advanced-production-toggle" type="button" aria-expanded={inheritedSettingsOpen} onClick={() => setInheritedSettingsOpen((current) => !current)}>
                <span>查看继承设置</span><small>上一版预填与本轮可调整设置</small><ChevronDown aria-hidden="true" size={17} />
              </button>
            </div> : null}
            <div hidden={Boolean(rework) && !inheritedSettingsOpen}>
            <section className="template-picker-section" aria-labelledby="template-picker-title">
              <div className="compact-section-heading">
                <div><span>00</span><h3 id="template-picker-title">视频模板</h3></div>
                <small>模板决定这条视频怎么讲，不锁死模型和素材</small>
              </div>
              {templates.length > 0 && (!rework || inheritedSettingsOpen) ? (
                <TemplateGallery
                  templates={templates}
                  selectedId={selectedTemplateId}
                  onSelect={selectTemplate}
                />
              ) : (
                <div className="template-loading" role={templateError ? "alert" : "status"} aria-live={templateError ? "assertive" : "polite"}>
                  <strong>{selectedTemplateId === "photo-story" ? "证据图解" : "正在准备推荐模板"}</strong>
                  <span>{templateError ?? (templateLoading ? "正在读取模板目录..." : "模板目录尚未读取。")}</span>
                  {templateError ? <button
                    className="button button-ghost"
                    type="button"
                    disabled={templateLoading}
                    onClick={() => void readTemplateCatalog(initializationRevision.current, selectedTemplateId, true)}
                  >{templateLoading ? "正在重新读取..." : "重新读取模板"}</button> : null}
                </div>
              )}
              {!initialValues?.rework && templateSelectionMissing ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />推荐模板当前不可用，请明确选择一个可用模板后再开始制作。</p> : null}
            </section>
            <section className="brief-section" aria-labelledby="brief-section-title">
              <div className="compact-section-heading">
                <div><span>01</span><h3 id="brief-section-title">内容简报</h3></div>
                <small>所有字段都可在生产前调整</small>
              </div>
              <div className="brief-fields">
                <label className="field field-wide">
                  <span>视频标题</span>
                  <input name="title" required data-dialog-initial-focus={rework ? undefined : true} defaultValue={initialValues?.title ?? ""} placeholder="一句能让人停下来的具体承诺" />
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
                    {!platform ? <option value="" disabled>请选择目标平台</option> : null}
                    <option value="douyin">抖音</option>
                    <option value="xiaohongshu">小红书</option>
                    <option value="bilibili">哔哩哔哩</option>
                  </select>
                </label>
                <label className="field field-compact">
                  <span>目标时长</span>
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
            </div>

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
                <div><span>02B</span><h3 id="reference-style-title">参考视频风格</h3></div>
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
              <p className="reference-style-note"><Film aria-hidden="true" size={16} /><span><strong>{referenceGrammarProvider ? creatorProviderName(referenceGrammarProvider) : "参考视频分析当前不可用"}</strong>只提炼节奏、构图、运镜、色彩、转场和声音结构；开工后原片作为私密运行输入留档，不进入发布包，分析结果可预览和编辑。</span></p>
              {referenceError ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />{referenceError}</p> : null}
            </section>

            <section className="recipe-section" aria-labelledby="recipe-section-title" data-tour="production-recipes">
              <div className="compact-section-heading">
                <div><span>03</span><h3 id="recipe-section-title">画面来源策略</h3></div>
                <small>决定导演可用能力，不设全片费用上限</small>
              </div>
              <fieldset className="recipe-options">
                <legend className="sr-only">制作配方</legend>
                {RECIPES.map((recipe) => {
                  const lockedByEditorial = imageStory && recipe.allowMeteredProviders;
                  const available = !lockedByEditorial && recipeAvailable(recipe, providers);
                  return (
                  <label key={recipe.id} className={available ? "recipe-option" : "recipe-option is-disabled"}>
                    <input type="radio" name="recipe" value={recipe.id} checked={recipeId === recipe.id} disabled={!available} onChange={() => applyRecipe(recipe.id)} />
                    <span className="recipe-option-body">
                      <span className="recipe-name">{recipe.recommended ? <Check aria-hidden="true" size={14} /> : <Sparkles aria-hidden="true" size={14} />}<strong>{recipe.label}</strong></span>
                      <small>{lockedByEditorial
                        ? `${recipe.description} · 图解类选题只使用来源画面和本地编辑画面`
                        : available ? recipe.description : `${recipe.description} · 需要先配置对应能力`}</small>
                    </span>
                  </label>
                  );
                })}
              </fieldset>
            </section>

            <section className="production-team-section" aria-labelledby="production-team-title">
              <div className="compact-section-heading">
                <div><span>04</span><h3 id="production-team-title">开工前确认制作团队</h3></div>
                <small>这里的选择会真实进入本次生产单</small>
              </div>
              <div className="production-role-grid">
                {CAPABILITIES.map((item) => {
                  const candidates = roleProviderCandidates(item, providers);
                  const requestedProviderId = effectiveBindings[item.key];
                  const selected = providers.find((provider) => provider.id === requestedProviderId);
                  const Icon = item.icon;
                  const models = selectableModelsForCapability(selected?.modelProfiles, item.capability);
                  const selectedModelId = selected ? modelSelections[selected.id] : undefined;
                  const inheritedProviderUnavailable = Boolean(requestedProviderId && !candidates.some((provider) => provider.id === requestedProviderId));
                  const inheritedModelUnavailable = Boolean(selectedModelId && !models.some((model) => model.id === selectedModelId));
                  return <article className={selected?.available ? "production-role" : "production-role is-unavailable"} key={item.key}>
                    <header>
                      <span className="production-role-icon"><Icon aria-hidden="true" size={17} /></span>
                      <span><strong>{item.role}</strong><small>{item.label}</small></span>
                      <em>{roleExecutionLabel(item, selected)}</em>
                    </header>
                    <label className="field production-role-provider">
                      <span>{item.role}能力</span>
                      <select
                        aria-label={`${item.role}能力`}
                        value={requestedProviderId ?? ""}
                        disabled={item.key === "voice" || (candidates.length < 2 && !inheritedProviderUnavailable)}
                        onChange={(event) => {
                          const provider = providers.find((candidate) => candidate.id === event.target.value);
                          if (!provider) return;
                          setBindings((current) => ({ ...current, [item.key]: provider.id }));
                          if (item.key === "visualReview") setVisualReviewEnabled(true);
                        }}
                      >
                        {!requestedProviderId ? <option value="">未配置</option> : null}
                        {inheritedProviderUnavailable ? <option value={requestedProviderId} disabled>上一版：{selected ? creatorProviderName(selected) : requestedProviderId}（不可用）</option> : null}
                        {candidates.map((provider) => <option value={provider.id} key={provider.id}>{creatorProviderName(provider)}</option>)}
                      </select>
                    </label>
                    {models.length > 0 && selected ? <label className="field production-role-model">
                      <span>{item.role}本次模型</span>
                      <select
                        aria-label={`${item.role}本次模型`}
                        value={selectedModelId ?? ""}
                        onChange={(event) => setModelSelections((current) => withModelSelection(current, selected.id, event.target.value))}
                      >
                        <option value="">继承推荐：{effectiveModelId(selected) ?? "由系统按当前配置选择"}</option>
                        {inheritedModelUnavailable && selectedModelId ? <option value={selectedModelId} disabled>上一版：{selectedModelId}（不可用）</option> : null}
                        {models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                      </select>
                      {(item.key === "script" || item.key === "director" || item.key === "visualReview") && models.length > 1
                        ? <small>你选的是首选；仅在连接、超时、限流或服务不可用时，才按兼容候选顺序接管。</small>
                        : null}
                    </label> : <p>{item.key === "voice" ? "音色与语速在下方声音导演中调整。" : selected?.description ?? item.description}</p>}
                    {item.key === "assets" ? <div className="production-role-source-models">
                      <strong>本次画面来源与模型</strong>
                      {selectedAssetSources.map((provider) => {
                        const models = selectableModelsForCapability(provider.modelProfiles, provider.capability);
                        const selectedModelId = modelSelections[provider.id];
                        const inheritedModelUnavailable = Boolean(selectedModelId && !models.some((model) => model.id === selectedModelId));
                        return <label className="field" key={provider.id}>
                        <span>{creatorProviderName(provider)}</span>
                        {models.length ? <select aria-label={`${creatorProviderName(provider)}开工模型`} value={selectedModelId ?? ""} onChange={(event) => setModelSelections((current) => withModelSelection(current, provider.id, event.target.value))}>
                          <option value="">使用推荐：{effectiveModelId(provider) ?? "自动选择"}</option>
                          {inheritedModelUnavailable && selectedModelId ? <option value={selectedModelId} disabled>上一版：{selectedModelId}（不可用）</option> : null}
                          {models.map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                        </select> : <small>{providerBillingLabel(provider)}</small>}
                      </label>;})}
                      <button className="button button-ghost" type="button" onClick={toggleAssetSourceControls}>{advancedOpen ? "收起来源" : "调整来源"}</button>
                    </div> : null}
                    <small className="production-role-billing">{selected
                      ? item.key === "assets"
                        ? meteredSelected
                          ? "画面方案本身不收费 · 按实际生成需求报价 · 生成前逐笔人工确认"
                          : "画面方案本身不收费 · 当前方案不调用付费生成"
                        : `${providerBillingLabel(selected)} · ${effectiveModelId(selected) ?? "不使用模型"}`
                      : "尚未选择制作方式"}</small>
                  </article>;
                })}
              </div>
              <div className={roleAuditProvider ? "production-auditor" : "production-auditor is-unavailable"}>
                <span><ScanSearch aria-hidden="true" size={18} /></span>
                <div><strong>{roleAuditProvider ? creatorProviderName(roleAuditProvider) : "独立质量复核未接通"}</strong><small>由独立 AI 逐步检查输入、交付格式和后续使用是否一致。</small></div>
                <em>{roleAuditProvider ? `${effectiveModelId(roleAuditProvider) ?? "实际使用模型"} · 深入质量复核 · 最多三轮` : "开工前请先恢复独立质量复核能力"}</em>
              </div>
            </section>

            <div hidden={Boolean(rework) && !inheritedSettingsOpen}>
            <div className={advancedOpen ? "advanced-production is-open" : "advanced-production"}>
              <button className="advanced-production-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                <span>更多：素材来源与制作细节</span><small>需要时再展开</small><ChevronDown aria-hidden="true" size={17} />
              </button>
              {advancedOpen ? <section className="workflow-config" aria-labelledby="workflow-config-title">
              <div className="workflow-stage-panel">
                <div className="compact-section-heading workflow-heading">
                  <div><span>A</span><h3 id="workflow-config-title">制作步骤</h3></div>
                  <small>点击步骤更换能力</small>
                </div>
                <div className="workflow-stage-list">
                  {CAPABILITIES.map((item, index) => {
                    const selected = providers.find((provider) => provider.id === effectiveBindings[item.key]);
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
                        <span><strong>{item.label}<em>{item.role}</em></strong><small>{selected ? creatorProviderName(selected) : "未配置"}</small></span>
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
                    const selected = effectiveBindings[activeKey] === provider.id;
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
                            <strong>{creatorProviderName(provider)}</strong>
                            <span className={provider.billing === "metered" ? "cost-tag is-metered" : "cost-tag"}>
                              {providerBillingLabel(provider)}
                            </span>
                          </span>
                          <span>{creatorFacingTechnicalText(provider.description) ?? "由系统按当前配置使用"}</span>
                          <span className="provider-mode-list">{(provider.modes ?? []).map((mode) => <small key={mode}>{creatorFacingTechnicalText(mode)}</small>)}</span>
                        </span>
                        <span className="provider-choice-status">
                          {provider.available ? <Check aria-hidden="true" size={15} /> : <AlertCircle aria-hidden="true" size={15} />}
                          {provider.available ? "可用" : provider.status === "planned" ? "待接入" : "待配置"}
                        </span>
                        {!provider.available && provider.requirement ? <small className="provider-requirement">{creatorFacingTechnicalText(provider.requirement)}</small> : null}
                      </label>
                    );
                  })}
                </div>
              </div>
              </section> : null}
              {advancedOpen ? <section ref={assetSourcePoolRef} className="asset-source-pool" aria-labelledby="asset-source-pool-title">
                <div className="compact-section-heading">
                  <div><span>B</span><h3 id="asset-source-pool-title">导演可用素材池</h3></div>
                  <small>{assetProviderIds.length} 项已启用，最终组合由 AI 生成</small>
                </div>
                <div className="asset-source-options">
                  {assetSources.map((provider) => {
                    const checked = assetProviderIds.includes(provider.id);
                    const disabled = !provider.available
                      || (provider.billing === "metered" && !selectedRecipe.allowMeteredProviders)
                      || (provider.id === "local-editorial-v1" && selectedTemplateId === "photo-story")
                      || (checked && assetProviderIds.length === 1);
                    return <label key={provider.id} className={checked ? "asset-source-option is-selected" : "asset-source-option"}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => toggleAssetProvider(provider)}
                      />
                      <span><strong>{creatorProviderName(provider)}</strong><small>{creatorFacingTechnicalText(provider.description) ?? "由系统按当前配置使用"}</small></span>
                      <em>{providerBillingLabel(provider)}</em>
                    </label>;
                  })}
                </div>
                {selectedAssetSources.some((provider) => selectableModelsForCapability(provider.modelProfiles, provider.capability).length) ? <div className="asset-model-overrides" aria-label="本次生成模型">
                  <div><strong>本次模型</strong><small>只覆盖这条制作，创作设置不会被修改</small></div>
                  {selectedAssetSources.filter((provider) => selectableModelsForCapability(provider.modelProfiles, provider.capability).length).map((provider) => {
                    const selectedModel = provider.modelProfiles?.find((model) => model.id === effectiveModelId(provider));
                    return <label className="field" key={provider.id}>
                      <span>{creatorProviderName(provider)}</span>
                      <select aria-label={`${creatorProviderName(provider)} 本次模型`} value={modelSelections[provider.id] ?? ""} onChange={(event) => setModelSelections((current) => {
                        const next = { ...current };
                        if (event.target.value) next[provider.id] = event.target.value;
                        else delete next[provider.id];
                        return next;
                      })}>
                        <option value="">使用推荐：{effectiveModelId(provider) ?? "自动选择"}</option>
                        {selectableModelsForCapability(provider.modelProfiles, provider.capability).map((model) => <option value={model.id} key={model.id}>{model.label}{model.recommended ? " · 推荐" : ""}</option>)}
                      </select>
                      <small>{selectedModel?.description}{selectedModel?.estimatedCnyPerClip !== undefined ? ` · 当前模型参考单价约 ¥${formatMoney(selectedModel.estimatedCnyPerClip)}/镜头，实际以逐项报价为准` : ""}</small>
                    </label>;
                  })}
                </div> : null}
              </section> : null}
            </div>

            <VoiceStudio
              sectionLabel="05"
              value={voiceDirection}
              preserveUnavailableSelection={Boolean(initialValues?.rework)}
              onSelectionAvailabilityChange={setVoiceSelectionAvailable}
              onUserChange={() => { voiceTouched.current = true; }}
              onChange={(next, providerId) => {
                setVoiceDirection(next);
                setBindings((current) => ({ ...current, voice: providerId }));
              }}
            />
            </div>

            <section className="production-guardrails" aria-label="开工前检查">
              <label className={effectiveSemanticRank ? "visual-review-control is-enabled" : "visual-review-control"}>
                <input type="checkbox" checked={effectiveSemanticRank} disabled={!semanticRankCompatible} onChange={(event) => setSemanticRankEnabled(event.target.checked)} />
                <span><Sparkles aria-hidden="true" size={17} /><strong>AI 候选画面排序</strong></span>
                <small>{semanticRankCompatible ? "先预览图库候选并给出逐镜排序；失败时保留素材源原顺序，下载前仍可人工调整" : "需要先启用 AI 视觉导演与逐镜画面选择"}</small>
              </label>
              <label className={effectiveVisualReviewEnabled ? "visual-review-control is-enabled" : "visual-review-control"}>
                <input
                  type="checkbox"
                  checked={effectiveVisualReviewEnabled && Boolean(visualReviewProvider)}
                  disabled={!visualReviewProvider || visualReviewRequired}
                  onChange={(event) => {
                    setVisualReviewEnabled(event.target.checked);
                    if (event.target.checked && visualReviewProvider) {
                      setBindings((current) => ({ ...current, visualReview: visualReviewProvider.id }));
                    }
                  }}
                />
                <span><ScanSearch aria-hidden="true" size={17} /><strong>视觉审片</strong></span>
                <small>{visualReviewProvider
                  ? `${creatorProviderName(visualReviewProvider)} · 抽帧审查，不上传音轨${visualReviewRequired ? "；付费画面必须启用" : ""}`
                  : "ZAI 视觉审片服务当前不可用，本次不会运行视觉审片"}</small>
              </label>
              {inheritedVisualReviewUnavailable && !visualReviewRequired ? <button
                className="button button-ghost"
                type="button"
                onClick={disableInheritedVisualReview}
              >本次停用视觉审片</button> : null}
              <div className="segmented-control review-control" aria-label="终审模式"><span>人工终审</span><small>发布前必须由你完整审片并批准</small></div>
              <div className="budget-control">
                <span><strong>费用确认方式</strong></span>
                <small>{[
                  meteredSelected ? "图片和视频按实际方案逐项报价，人工确认后才执行" : "图片和视频不会产生现金报价",
                  automaticVoiceProvider ? "配音自动记入成本账，不弹现金报价；失败会停在配音步骤" : "",
                  subscriptionVisualReview ? "视觉审片使用订阅额度，不产生现金报价；质量问题会停在审片步骤" : "",
                ].filter(Boolean).join("；")}</small>
              </div>
            </section>

            {missingProductionRoles.length > 0 ? <p className="form-error"><AlertCircle aria-hidden="true" size={16} />缺少正式生产能力：{missingProductionRoles.join("、")}。请先在创作设置中完成配置。<a className="button button-ghost" href={capabilitySettingsHref}>打开创作设置</a></p> : null}
            {error ? <p className="form-error" role="alert"><AlertCircle aria-hidden="true" size={16} />{error}</p> : null}
          </div>

          <footer className="dialog-actions recipe-dialog-actions">
            <div><strong>{selectedRecipe.label}</strong><span>{meteredSelected ? "图片 / 视频按实际方案报价 · 逐项人工确认" : roleAuditProvider?.billing === "subscription" ? "订阅能力不产生现金报价" : "图片 / 视频无现金报价"}</span></div>
            <button className="button button-ghost" type="button" onClick={onClose} disabled={submitting}>取消</button>
            <button className="button button-primary" type="button" onClick={(event) => {
              if (event.currentTarget.form?.reportValidity()) void submit(event.currentTarget.form);
            }} disabled={submitting || referenceUploading || !templatesLoaded || productionBlocked} data-tour="production-start">
              <Check aria-hidden="true" size={17} />
              {submitting ? "正在创建..." : "开始制作"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function productionStepLabel(capability: string): string {
  return CAPABILITIES.find((item) => item.capability === capability)?.label ?? "其他制作步骤";
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

function creatorVoiceWasCustomized(settings?: StudioCreatorSettings): boolean {
  if (!settings) return false;
  if (settings.voiceDirectionCustomized !== undefined) return settings.voiceDirectionCustomized;
  return settings.voiceDirection.profileId !== "macos:Tingting"
    || settings.voiceDirection.rate !== 185
    || settings.voiceDirection.pauseScale !== 1
    || settings.voiceDirection.masteringPreset !== "natural";
}

function providerDefaults(
  providers: StudioProvider[],
  roleDefaults: StudioCreatorSettings["roleProviderDefaults"] = {},
): StudioProductionInput["providers"] {
  return Object.fromEntries(CAPABILITIES.map((item) => {
    const candidates = providers.filter((provider) => provider.capability === item.capability && provider.kind !== "test");
    const preferredId = item.key === "voice"
      ? providerForVoiceProfile(defaultVoiceDirection(providers).profileId)
      : roleDefaults?.[item.key] ?? item.preferred;
    const selected = candidates.find((provider) => provider.id === preferredId && provider.available)
      ?? candidates.find((provider) => provider.available);
    return [item.key, selected?.id ?? ""];
  })) as StudioProductionInput["providers"];
}

function availableProviderBindings(
  requested: StudioProductionInput["providers"],
  defaults: StudioProductionInput["providers"],
  providers: StudioProvider[],
): StudioProductionInput["providers"] {
  return Object.fromEntries(CAPABILITIES.map((item) => {
    const candidates = roleProviderCandidates(item, providers);
    const selected = candidates.find((provider) => provider.id === requested[item.key])
      ?? candidates.find((provider) => provider.id === defaults[item.key])
      ?? candidates[0];
    return [item.key, selected?.id ?? ""];
  })) as StudioProductionInput["providers"];
}

function roleProviderCandidates(item: CapabilityDefinition, providers: StudioProvider[]): StudioProvider[] {
  return providers.filter((provider) => {
    if (!provider.available || provider.kind === "test" || provider.capability !== item.capability) return false;
    return item.key !== "assets" || provider.id === "ai-shot-router-v1";
  });
}

function roleExecutionLabel(item: CapabilityDefinition, provider: StudioProvider | undefined): string {
  if (!provider?.available) return "未配置";
  if (item.key === "visualReview") return "模型审片";
  if (provider.id.startsWith("codex-") || provider.id === "api-visual-director-v1") return "AI 创作 · 最多 3 轮质量修订";
  if (provider.id === "ai-shot-router-v1") return "AI 逐镜选择画面来源";
  return "确定性工具";
}

function withModelSelection(current: Record<string, string>, providerId: string, modelId: string): Record<string, string> {
  const next = { ...current };
  if (modelId) next[providerId] = modelId;
  else delete next[providerId];
  return next;
}

function providerForVoiceProfile(profileId: string): string {
  if (profileId.startsWith("tone:")) return "ffmpeg-tone-test-v1";
  if (profileId.startsWith("kokoro:")) return "kokoro-local-v1";
  if (profileId.startsWith("minimax:")) return "minimax-tts-v1";
  return "macos-say-v1";
}

function recipeAvailable(recipe: (typeof RECIPES)[number], providers: StudioProvider[]): boolean {
  const foundationReady = providers.some((provider) => provider.id === "api-visual-director-v1" && provider.available)
    && providers.some((provider) => provider.id === "ai-shot-router-v1" && provider.available);
  if (!foundationReady) return false;
  if (!recipe.allowMeteredProviders) {
    return providers.some((provider) => isAutomaticAssetSource(provider) && provider.available && provider.billing !== "metered");
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
    .filter((provider) => isAutomaticAssetSource(provider) && provider.available && provider.billing !== "metered")
    .map((provider) => provider.id);
  if (!recipe.allowMeteredProviders) return free;
  const preferredMetered = preferredId
    ? providers.find((provider) => {
        return provider.id === preferredId
          && provider.available
          && isAssetSource(provider)
          && provider.billing === "metered"
          && provider.estimatedCnyPerClip;
      })
    : undefined;
  const metered = preferredMetered ?? providers
    .filter((provider) => isAssetSource(provider) && provider.available && provider.billing === "metered" && provider.estimatedCnyPerClip)
    .sort((left, right) => (left.estimatedCnyPerClip ?? Infinity) - (right.estimatedCnyPerClip ?? Infinity))[0];
  return metered ? [...free, metered.id] : free;
}

function includeLocalEditorialSource(sourceIds: string[], providers: StudioProvider[]): string[] {
  const localEditorial = providers.find((provider) => provider.id === "local-editorial-v1" && provider.available && isAssetSource(provider));
  return localEditorial && !sourceIds.includes(localEditorial.id) ? [...sourceIds, localEditorial.id] : sourceIds;
}

function isAssetSource(provider: StudioProvider): boolean {
  return provider.capability === "asset.prepare" && provider.kind !== "test" && provider.id !== "ai-shot-router-v1";
}

function isAutomaticAssetSource(provider: StudioProvider): boolean {
  return isAssetSource(provider) && provider.id !== "local-editorial-v1";
}

function creatorFacingRework(
  rework: StudioProductionInput["rework"] | undefined,
  requiredAffectedScenePositions?: number[],
): StudioProductionInput["rework"] | undefined {
  if (!rework) return undefined;
  const draft = structuredClone(rework);
  const present = (value: string) => creatorFacingTechnicalText(value) ?? value;
  // 审片事实参与服务端完整性校验，展示时转换即可，不能改写后再提交。
  draft.nodeInstructions = {
    script: present(draft.nodeInstructions.script),
    visualDirection: present(draft.nodeInstructions.visualDirection),
    assets: present(draft.nodeInstructions.assets),
  };
  const fullScenePositions = verifiedReworkScenePositions(draft);
  if (fullScenePositions) {
    draft.affectedScenePositions = defaultReworkScenePositions(
      draft,
      fullScenePositions,
      requiredAffectedScenePositions,
    );
  }
  return draft;
}

const REWORK_BASELINE_NODE_LABELS: Record<string, string> = {
  brief: "需求简报",
  template: "视频模板",
  script: "上一版脚本",
  "visual-direction": "上一版导演方案",
  "visual-review": "视觉审片记录",
};

function isLegalScenePosition(position: unknown): position is number {
  return typeof position === "number" && Number.isInteger(position) && position > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 排序后必须严格是 1..N：缺号或跳号都说明历史镜头集合不完整，不能用来推导“计划沿用”。
function strictlyOrderedScenePositions(positions: number[]): number[] | undefined {
  const sorted = [...positions].sort((left, right) => left - right);
  return sorted.every((position, index) => position === index + 1) ? sorted : undefined;
}

function verifiedScenePositionsFromScript(previousScript: unknown): number[] | undefined {
  if (!isPlainRecord(previousScript) || !Array.isArray(previousScript.scenes)) return undefined;
  const positions: number[] = [];
  const seen = new Set<number>();
  for (const scene of previousScript.scenes) {
    if (!isPlainRecord(scene)) return undefined;
    const position = scene.position;
    if (!isLegalScenePosition(position)) return undefined;
    // 每个脚本镜头只有一个编号；重复编号说明历史数据不可靠，不能静默去重。
    if (seen.has(position)) return undefined;
    seen.add(position);
    positions.push(position);
  }
  return positions.length > 0 ? strictlyOrderedScenePositions(positions) : undefined;
}

function verifiedScenePositionsFromDirectorPlan(previousDirectorPlan: unknown): number[] | undefined {
  if (!isPlainRecord(previousDirectorPlan) || !Array.isArray(previousDirectorPlan.shots)) return undefined;
  const positions: number[] = [];
  const seen = new Set<number>();
  for (const shot of previousDirectorPlan.shots) {
    if (!isPlainRecord(shot)) return undefined;
    const position = shot.scenePosition;
    if (!isLegalScenePosition(position)) return undefined;
    // 正常合同里每个脚本镜头只有一个 shot；重复镜头号不是合法的多 shot 同 scene。
    if (seen.has(position)) return undefined;
    seen.add(position);
    positions.push(position);
  }
  return positions.length > 0 ? strictlyOrderedScenePositions(positions) : undefined;
}

function verifiedReworkScenePositions(
  rework: StudioProductionInput["rework"] | undefined,
): number[] | undefined {
  if (!rework) return undefined;
  const scriptPositions = verifiedScenePositionsFromScript(rework.previousScript);
  const directorPositions = verifiedScenePositionsFromDirectorPlan(rework.previousDirectorPlan);
  if (scriptPositions && directorPositions) {
    return scriptPositions.length === directorPositions.length
      && scriptPositions.every((position, index) => position === directorPositions[index])
      ? scriptPositions
      : undefined;
  }
  return scriptPositions ?? directorPositions;
}

function defaultReworkScenePositions(
  rework: NonNullable<StudioProductionInput["rework"]>,
  fullScenePositions: number[],
  requiredAffectedScenePositions: number[] | undefined,
): number[] {
  const knownPositions = new Set(fullScenePositions);
  const selected = new Set<number>();
  for (const position of rework.affectedScenePositions ?? []) {
    if (knownPositions.has(position)) selected.add(position);
  }
  for (const position of requiredAffectedScenePositions ?? []) {
    if (knownPositions.has(position)) selected.add(position);
  }
  let hasUnlocatedVisualFinding = false;
  for (const finding of rework.findings ?? []) {
    if (!isLegalScenePosition(finding.scenePosition) || !knownPositions.has(finding.scenePosition)) {
      // 只有真正指向导演/素材的未定位 finding 才能把画面返工扩大到全片；
      // 脚本或其他节点的全片问题不改变画面镜头选择，显式空范围因此得以保留。
      if (finding.targetNodeIds.some((nodeId) => nodeId === "visual-direction" || nodeId === "assets")) {
        hasUnlocatedVisualFinding = true;
      }
      continue;
    }
    selected.add(finding.scenePosition);
  }
  const explicitlyCleared = Array.isArray(rework.affectedScenePositions)
    && rework.affectedScenePositions.length === 0;
  if (hasUnlocatedVisualFinding || (!explicitlyCleared && selected.size === 0)) {
    return [...fullScenePositions];
  }
  return fullScenePositions.filter((position) => selected.has(position));
}

function requiredScenePositionsForRework(
  rework: StudioProductionInput["rework"] | undefined,
  requiredAffectedScenePositions: number[] | undefined,
): number[] {
  const fullScenePositions = verifiedReworkScenePositions(rework);
  if (!rework || !fullScenePositions) return [];
  const knownPositions = new Set(fullScenePositions);
  const required = new Set<number>();
  for (const position of requiredAffectedScenePositions ?? []) {
    if (knownPositions.has(position)) required.add(position);
  }
  let hasUnlocatedRequiredFinding = false;
  for (const finding of rework.findings ?? []) {
    const targetsVisualWork = finding.targetNodeIds.some((nodeId) => nodeId === "visual-direction" || nodeId === "assets");
    const targetsLocatedScriptWork = finding.targetNodeIds.includes("script") && finding.scenePosition !== undefined;
    if (!targetsVisualWork && !targetsLocatedScriptWork) continue;
    if (!isLegalScenePosition(finding.scenePosition) || !knownPositions.has(finding.scenePosition)) {
      hasUnlocatedRequiredFinding = true;
      continue;
    }
    required.add(finding.scenePosition);
  }
  return hasUnlocatedRequiredFinding
    ? [...fullScenePositions]
    : fullScenePositions.filter((position) => required.has(position));
}

function toggleReworkScene(
  rework: StudioProductionInput["rework"] | undefined,
  position: number,
): StudioProductionInput["rework"] | undefined {
  if (!rework) return undefined;
  const fullScenePositions = verifiedReworkScenePositions(rework);
  if (!fullScenePositions?.includes(position)) return rework;
  const selected = new Set(rework.affectedScenePositions ?? []);
  if (selected.has(position)) selected.delete(position);
  else selected.add(position);
  return {
    ...rework,
    affectedScenePositions: fullScenePositions.filter((scenePosition) => selected.has(scenePosition)),
  };
}

interface GroupedReworkFindings {
  sceneGroups: Array<{ scenePosition: number; findings: StudioReworkFinding[] }>;
  wholeFilmFindings: StudioReworkFinding[];
}

function groupReworkFindingsByScene(findings: StudioReworkFinding[] | undefined): GroupedReworkFindings {
  const seenFindingIds = new Set<string>();
  const uniqueFindings: StudioReworkFinding[] = [];
  findings?.forEach((finding, index) => {
    // 只按相同 findingId 去重；不同 finding 即使分类或描述相同也全部保留。
    const identity = finding.findingId || `finding-${index}`;
    if (seenFindingIds.has(identity)) return;
    seenFindingIds.add(identity);
    uniqueFindings.push(finding);
  });
  const sceneGroups = new Map<number, StudioReworkFinding[]>();
  const wholeFilmFindings: StudioReworkFinding[] = [];
  for (const finding of uniqueFindings) {
    const position = finding.scenePosition;
    if (!isLegalScenePosition(position)) {
      wholeFilmFindings.push(finding);
      continue;
    }
    const group = sceneGroups.get(position) ?? [];
    group.push(finding);
    sceneGroups.set(position, group);
  }
  return {
    sceneGroups: [...sceneGroups.entries()]
      .sort(([left], [right]) => left - right)
      .map(([scenePosition, grouped]) => ({ scenePosition, findings: grouped })),
    wholeFilmFindings,
  };
}

interface ReworkScopeSummary {
  adjustedScenePositions: number[];
  fullScenePositions?: number[];
  plannedReuseScenePositions: number[];
}

function summarizeReworkScope(
  rework: StudioProductionInput["rework"] | undefined,
): ReworkScopeSummary | undefined {
  if (!rework) return undefined;
  const fullScenePositions = verifiedReworkScenePositions(rework);
  if (!fullScenePositions) return { adjustedScenePositions: [], plannedReuseScenePositions: [] };
  const selected = new Set(rework.affectedScenePositions ?? []);
  const adjustedScenePositions = fullScenePositions.filter((position) => selected.has(position));
  return {
    adjustedScenePositions,
    fullScenePositions,
    plannedReuseScenePositions: fullScenePositions.filter((position) => !adjustedScenePositions.includes(position)),
  };
}

// 继承文案只承诺真实存在的上一版基线资料：早期节点失败的 rework 可能没有脚本或导演方案产物。
function reworkBaselineSummary(rework: NonNullable<StudioProductionInput["rework"]>): string {
  const suffix = "这些文字是待执行要求，不代表问题已经修好。";
  if (rework.previousScript && rework.previousDirectorPlan) {
    return `上一版脚本和导演方案会作为修改基线带入；${suffix}`;
  }
  if (rework.previousScript) {
    return `上一版脚本会作为修改基线带入，本轮需要重新规划画面方案；${suffix}`;
  }
  if (rework.previousDirectorPlan) {
    return `上一版导演方案会作为修改基线带入，本轮需要重新生成脚本；${suffix}`;
  }
  return `上一版未留下脚本和导演方案，本轮需要重新生成脚本并重新规划画面方案；${suffix}`;
}

const REWORK_FINDING_TARGET_NODE_ORDER = ["script", "visual-direction", "assets"] as const;

const REWORK_FINDING_TARGET_NODE_LABELS: Record<string, string> = {
  script: "脚本",
  "visual-direction": "导演方案",
  assets: "画面素材",
};

// 展示的影响步骤只来自去重后 findings 的 targetNodeIds 并集；不从 category、描述或关键词推断。
function reworkFindingTargetStepLabels(grouped: GroupedReworkFindings): string[] {
  const targeted = new Set<string>();
  for (const group of grouped.sceneGroups) {
    for (const finding of group.findings) {
      for (const nodeId of finding.targetNodeIds ?? []) targeted.add(nodeId);
    }
  }
  for (const finding of grouped.wholeFilmFindings) {
    for (const nodeId of finding.targetNodeIds ?? []) targeted.add(nodeId);
  }
  return REWORK_FINDING_TARGET_NODE_ORDER
    .filter((nodeId) => targeted.has(nodeId))
    .map((nodeId) => REWORK_FINDING_TARGET_NODE_LABELS[nodeId]!);
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

function formatMoney(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatTimecode(timecodeMs: number): string {
  const totalSeconds = Math.floor(timecodeMs / 1_000);
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function reworkFindingCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    composition: "构图",
    continuity: "画面连续性",
    pacing: "节奏",
    legibility: "可读性",
    typography: "画面文字",
    narration: "旁白",
    safety: "内容安全",
    other: "其他问题",
  };
  return labels[category.trim().toLowerCase()] ?? "其他问题";
}

function providerBillingLabel(provider: StudioProvider): string {
  if (provider.billing === "subscription") return "订阅额度";
  if (provider.billing !== "metered") return "免费";
  const unit = provider.billingUnit === "run" ? "次" : "镜头";
  return provider.estimatedCnyPerClip === undefined
    ? "待估价"
    : `约 ¥${formatMoney(provider.estimatedCnyPerClip)}/${unit}`;
}

function creatorProviderName(provider: StudioProvider): string {
  const normalized = providerLabel(provider.id);
  return !normalized || normalized === provider.id ? provider.label : normalized;
}
