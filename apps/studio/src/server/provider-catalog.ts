import type { StudioProvider, StudioTrendService, StudioTrendSource } from "../shared/api.js";
import {
  resolveCodexSocketPath,
  resolveZaiCodexSocketPath,
  resolveZaiVisualReviewModelId,
  type CodexProviderSettings,
} from "./codex-provider-settings.js";
import {
  DEFAULT_MINIMAX_VIDEO_MODEL_ID,
  DEFAULT_SEEDANCE_MODEL_ID,
  DEFAULT_WAN_VIDEO_MODEL_ID,
  readMeteredVideoProviderSettings,
  reviewedVideoModelCatalog,
} from "./video-provider-settings.js";
import { readMeteredImageProviderSettings } from "./image-provider-settings.js";

export interface ProviderRuntime {
  python: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  say: boolean;
}

export type CodexCatalogAvailability = Pick<CodexProviderSettings, "available" | "reason"> & {
  taskKinds?: readonly string[];
  modelId?: string;
  taskModels?: Record<string, string>;
};

type AssetDeliveryType = NonNullable<StudioProvider["deliveryTypes"]>[number];

const ASSET_PROVIDER_DELIVERY_TYPES = {
  "local-editorial-v1": ["editorial_card"],
  "pexels-stock-v1": ["stock_video", "stock_image"],
  "pixabay-stock-v1": ["stock_video", "stock_image"],
  "seedream-image-v1": ["generated_image"],
  "seedance-video-v1": ["generated_video"],
  "hailuo-video-v1": ["generated_video"],
  "wan-video-v1": ["generated_video"],
  "kling-video-v1": ["generated_video"],
  "vidu-video-v1": ["generated_video"],
} as const satisfies Record<string, readonly AssetDeliveryType[]>;

export function assetProviderDeliveryTypes(providerId: string): AssetDeliveryType[] {
  const deliveryTypes = ASSET_PROVIDER_DELIVERY_TYPES[providerId as keyof typeof ASSET_PROVIDER_DELIVERY_TYPES];
  if (!deliveryTypes) throw new Error(`Asset provider '${providerId}' is missing its delivery type declaration.`);
  return [...deliveryTypes];
}

export function buildProviderCatalog(
  runtime: ProviderRuntime,
  environment: NodeJS.ProcessEnv,
  codexAvailability?: CodexCatalogAvailability,
  zaiCodexAvailability?: CodexCatalogAvailability,
): StudioProvider[] {
  const videoSettings = readMeteredVideoProviderSettings(environment);
  const reviewedVideoModels = reviewedVideoModelCatalog(environment);
  const imageSettings = readMeteredImageProviderSettings(environment);
  const seedreamSettings = imageSettings.find((setting) => setting.providerId === "seedream-image-v1");
  const seedanceSettings = videoSettings.find((setting) => setting.providerId === "seedance-video-v1");
  const miniMaxSettings = videoSettings.find((setting) => setting.providerId === "hailuo-video-v1");
  const wanSettings = videoSettings.find((setting) => setting.providerId === "wan-video-v1");
  const seedanceAvailable = runtime.python && seedanceSettings !== undefined;
  const seedreamAvailable = runtime.python && seedreamSettings !== undefined;
  const miniMaxAvailable = runtime.python && miniMaxSettings !== undefined;
  const wanAvailable = runtime.python && wanSettings !== undefined;
  const miniMaxTtsAvailable = runtime.python && runtime.ffmpeg && Boolean(environment.MINIMAX_API_KEY);
  const codex = codexAvailability ?? probeCodexSynchronously(environment);
  const reportedCodexModelId = codex.modelId?.trim() || environment.VIDEO_FACTORY_CODEX_MODEL?.trim();
  const codexModelId = reportedCodexModelId || "codex-default";
  const modelForTask = (taskKind: string) => codex.taskModels?.[taskKind]?.trim() || codexModelId;
  const codexProfiles = (
    providerId: string,
    taskKind: string,
    taskType: "text" | "visual-review" = "text",
    runtimeAvailable = true,
  ) => [textModelProfile(
    modelForTask(taskKind),
    modelForTask(taskKind) === "codex-default" ? "由 Codex 运行时决定" : modelForTask(taskKind),
    "codex-broker",
    "openai",
    codex.available,
    modelForTask(taskKind) === "codex-default"
      ? "Codex broker 尚未报告具体模型；首次调用后会记录实际模型。"
      : "服务器 Codex broker 针对此角色实际使用的模型；切换需要更新运行时配置并重启 broker。",
  )].map((model) => ({
    ...model,
    providerId,
    available: runtimeAvailable && supportsTask(codex, taskKind),
    taskTypes: [taskType],
  }));
  const codexRequirement = (taskKind: string) => providerTaskRequirement(resolveCodexSocketPath(environment).requirement, codex, taskKind);
  const zaiCodex = zaiCodexAvailability ?? { available: false, reason: "尚未完成独立 broker 协议健康检查。" };
  const zaiCodexRequirement = providerTaskRequirement(resolveZaiCodexSocketPath(environment).requirement, zaiCodex, "visual-review");
  const zaiModelId = zaiCodex.modelId?.trim() || resolveZaiVisualReviewModelId(environment);
  const zaiModelLabel = zaiModelId === "glm-5.3-flash" ? "GLM-5.3-Flash" : zaiModelId;
  const zaiVisualProducerAvailable = supportsTask(zaiCodex, "visual-review");
  const independentAuditAvailable = supportsTask(codex, "role-audit");
  const zaiVisualReviewAvailable = runtime.python
    && runtime.ffmpeg
    && runtime.ffprobe
    && zaiVisualProducerAvailable
    && independentAuditAvailable;
  const zaiVisualReviewRequirement = !zaiVisualProducerAvailable
    ? zaiCodexRequirement
    : !independentAuditAvailable
      ? `GLM 审片意见必须经过独立 Codex Agent 质量复核。${codexRequirement("role-audit")}`
      : zaiCodexRequirement;

  return [
    provider({
      id: "api-topic-editor-v1",
      capability: "topic.intelligence",
      label: "Codex 选题总编",
      available: supportsTask(codex, "topic-ideas"),
      kind: "external",
      billing: "subscription",
      description: "通过宿主机 Codex 把实时热点转译为可拍摄、可连载的中文短视频角度；失败时回退到确定性评分。",
      modes: ["热点理解", "选题提案", "结构化输出"],
      latency: "seconds",
      defaultModelId: modelForTask("topic-ideas"),
      modelProfiles: codexProfiles("api-topic-editor-v1", "topic-ideas"),
      requirement: codexRequirement("topic-ideas"),
    }),
    provider({
      id: "codex-series-showrunner-v1",
      capability: "series.plan",
      label: "Codex 系列主理人",
      available: supportsTask(codex, "series-roadmap"),
      kind: "external",
      billing: "subscription",
      description: "维护 Series Bible、Canon 与集间承接，规划长期路线并在单集开拍前重新绿灯审计。",
      modes: ["系列圣经", "连续性", "单集绿灯", "三轮自审"],
      latency: "seconds",
      defaultModelId: modelForTask("series-roadmap"),
      modelProfiles: codexProfiles("codex-series-showrunner-v1", "series-roadmap"),
      requirement: codexRequirement("series-roadmap"),
    }),
    provider({
      id: "python-template-v1",
      capability: "script.draft",
      label: "模板脚本",
      available: runtime.python,
      kind: "local",
      description: "本地规则模板，零调用成本，适合先跑通选题和节奏。",
      modes: ["结构化脚本", "5 段分镜"],
      latency: "seconds",
      requirement: "需要 python3",
    }),
    provider({
      id: "codex-screenwriter-v1",
      capability: "script.draft",
      label: "Codex 编剧",
      available: supportsTask(codex, "script-draft"),
      kind: "external",
      billing: "subscription",
      description: "按选题角度撰写可拍、可朗读、可核验的分镜脚本；编剧失败时制作明确失败，不回退模板。",
      modes: ["口语旁白", "3-10 场分镜", "逐场画面指令"],
      latency: "seconds",
      defaultModelId: modelForTask("script-draft"),
      modelProfiles: codexProfiles("codex-screenwriter-v1", "script-draft"),
      requirement: codexRequirement("script-draft"),
    }),
    provider({
      id: "api-visual-director-v1",
      capability: "storyboard.plan",
      label: "Codex 视觉导演",
      available: supportsTask(codex, "director-plan"),
      kind: "external",
      billing: "subscription",
      description: "统一全片视觉规则，并根据叙事、真实性、连续性和可执行性逐镜选择画面来源。",
      modes: ["导演角色", "全片视觉规则", "逐镜选画面"],
      latency: "seconds",
      defaultModelId: modelForTask("director-plan"),
      modelProfiles: codexProfiles("api-visual-director-v1", "director-plan"),
      requirement: codexRequirement("director-plan"),
    }),
    provider({
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe && supportsTask(codex, "reference-grammar"),
      kind: "external",
      billing: "subscription",
      description: "安全抽取参考视频关键帧，只提炼节奏、构图、运镜、色彩、转场和声音结构等风格规则。",
      modes: ["关键帧分析", "镜头语法", "可编辑规则", "订阅能力"],
      latency: "seconds",
      defaultModelId: modelForTask("reference-grammar"),
      modelProfiles: codexProfiles(
        "codex-reference-grammar-v1",
        "reference-grammar",
        "text",
        runtime.python && runtime.ffmpeg && runtime.ffprobe,
      ),
      requirement: codexRequirement("reference-grammar"),
    }),
    provider({
      id: "codex-asset-ranker-v1",
      capability: "asset.rank.semantic",
      label: "Codex 候选画面排序",
      available: supportsTask(codex, "asset-rank"),
      kind: "external",
      billing: "subscription",
      description: "在下载前依据逐镜意图重排图库候选；不可用时保留确定性原始排序。",
      modes: ["候选排序", "逐项理由", "人工锁定", "订阅能力"],
      latency: "seconds",
      defaultModelId: modelForTask("asset-rank"),
      modelProfiles: codexProfiles("codex-asset-ranker-v1", "asset-rank"),
      requirement: codexRequirement("asset-rank"),
    }),
    provider({
      id: "ai-shot-router-v1",
      capability: "asset.prepare",
      label: "AI 逐镜路由",
      available: runtime.python && supportsTask(codex, "director-plan"),
      kind: "external",
      description: "执行导演计划；每个镜头可独立调用本地、图库或图片及视频生成能力。",
      modes: ["逐镜决策", "多来源", "逐项报价"],
      latency: "seconds",
      requirement: "需要 Python 和 Codex 视觉导演",
    }),
    provider({
      id: "local-editorial-v1",
      capability: "asset.prepare",
      label: "本地编辑卡片",
      available: runtime.python,
      kind: "local",
      description: "只在导演明确选择标题、数据或片尾排版时制作正式画面，不承担素材失败的替代方案。",
      modes: ["9:16", "主动排版", "本地生成"],
      deliveryTypes: assetProviderDeliveryTypes("local-editorial-v1"),
      latency: "seconds",
      requirement: "需要 python3",
    }),
    provider({
      id: "pexels-stock-v1",
      capability: "asset.prepare",
      label: "Pexels 视频",
      available: runtime.python && Boolean(environment.PEXELS_API_KEY),
      kind: "external",
      description: "免费图库实拍镜头，适合日常、职场和环境类补画面。",
      modes: ["实拍视频", "实拍图片", "9:16 搜索"],
      deliveryTypes: assetProviderDeliveryTypes("pexels-stock-v1"),
      latency: "seconds",
      requirement: "需要 PEXELS_API_KEY",
      docsUrl: "https://www.pexels.com/api/",
    }),
    provider({
      id: "pixabay-stock-v1",
      capability: "asset.prepare",
      label: "Pixabay 视频",
      available: runtime.python && Boolean(environment.PIXABAY_API_KEY),
      kind: "external",
      description: "免费图库补充源，可在配置后单独选择用于实拍画面搜索。",
      modes: ["实拍视频", "实拍图片", "安全搜索"],
      deliveryTypes: assetProviderDeliveryTypes("pixabay-stock-v1"),
      latency: "seconds",
      requirement: "需要 PIXABAY_API_KEY",
      docsUrl: "https://pixabay.com/api/docs/",
    }),
    provider({
      id: "seedream-image-v1",
      capability: "asset.prepare",
      label: "Seedream 关键画面",
      available: seedreamAvailable,
      kind: "external",
      billing: "metered",
      status: seedreamAvailable ? "ready" : "needs_config",
      description: "火山方舟同步生成竖屏关键画面，适合解释性插画、概念视觉和系列统一风格。",
      modes: ["文生图", "9:16", "单张关键画面"],
      deliveryTypes: assetProviderDeliveryTypes("seedream-image-v1"),
      latency: "seconds",
      ...(seedreamSettings ? { estimatedCnyPerClip: seedreamSettings.estimatedCnyPerImage } : {}),
      ...(seedreamSettings ? {
        defaultModelId: seedreamSettings.model,
        modelProfiles: [{
          id: seedreamSettings.model,
          label: "Seedream 关键画面",
          providerId: "seedream-image-v1",
          providerFamily: "ark-image",
          available: seedreamAvailable,
          recommended: true,
          description: "当前火山方舟关键画面模型，按单张图片估算费用。",
          taskTypes: ["text-to-image" as const],
          estimatedCnyPerClip: seedreamSettings.estimatedCnyPerImage,
        }],
      } : {}),
      requirement: "需要 ARK_API_KEY；模型与单图估价可用保守默认值覆盖",
      docsUrl: "https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01",
    }),
    provider({
      id: "seedance-video-v1",
      providerFamily: "ark-video",
      capability: "asset.prepare",
      label: "火山方舟视频",
      available: seedanceAvailable,
      kind: "external",
      billing: "metered",
      status: seedanceAvailable ? "ready" : "needs_config",
      description: "通过同一个火山方舟协议调用可配置的视频模型；实际选中镜头逐项报价并等待人工确认。",
      modes: ["文生视频", "9:16", "2-15 秒", "无声素材"],
      deliveryTypes: assetProviderDeliveryTypes("seedance-video-v1"),
      latency: "minutes",
      ...(seedanceSettings ? { estimatedCnyPerClip: seedanceSettings.estimatedCnyPerClip } : {}),
      defaultModelId: seedanceSettings?.model ?? (environment.SEEDANCE_MODEL_ID?.trim() || DEFAULT_SEEDANCE_MODEL_ID),
      modelProfiles: (seedanceSettings?.models ?? reviewedVideoModels["seedance-video-v1"]).map((model) => ({
        ...model,
        providerId: "seedance-video-v1",
        providerFamily: "ark-video",
        available: seedanceAvailable,
        description: model.recommended
          ? "当前推荐的方舟视频模型，适合精品关键镜头与受控小额验证。"
          : "同一方舟 API 下的可选视频模型，可按项目或节点覆盖默认值。",
      })),
      requirement: "需要 ARK_API_KEY 和 SEEDANCE_ESTIMATED_CNY_PER_CLIP；模型可在页面配置",
      docsUrl: "https://www.volcengine.com/docs/82379/1520757?lang=zh",
    }),
    provider({
      id: "hailuo-video-v1",
      capability: "asset.prepare",
      label: "MiniMax 视频生成",
      available: miniMaxAvailable,
      kind: "external",
      billing: "metered",
      status: miniMaxAvailable ? "ready" : "needs_config",
      description: "同一个 MiniMax Provider 下可选择 Hailuo 或 H3；H3 支持 4–15 秒、原生音画与最高 2K。",
      modes: ["文生视频", "4–15 秒", "最高 2K", "逐镜可选模型"],
      deliveryTypes: assetProviderDeliveryTypes("hailuo-video-v1"),
      latency: "minutes",
      ...(miniMaxSettings ? { estimatedCnyPerClip: miniMaxSettings.estimatedCnyPerClip } : {}),
      defaultModelId: miniMaxSettings?.model ?? (environment.MINIMAX_VIDEO_MODEL_ID?.trim() || DEFAULT_MINIMAX_VIDEO_MODEL_ID),
      modelProfiles: (miniMaxSettings?.models ?? reviewedVideoModels["hailuo-video-v1"]).map((model) => ({
        ...model,
        providerId: "hailuo-video-v1",
        providerFamily: "minimax-video",
        available: miniMaxAvailable,
        description: model.estimatedCnyPerSecond
          ? `${model.label} 按时长与分辨率计费，默认规格约 ¥${model.estimatedCnyPerSecond.toFixed(2)}/秒；执行前按实际镜头重新核算。`
          : "MiniMax Hailuo 固定规格视频模型；实际选中镜头逐项报价并等待人工确认。",
      })),
      requirement: "需要 MINIMAX_API_KEY、MINIMAX_VIDEO_MODEL_ID 和 MINIMAX_ESTIMATED_CNY_PER_CLIP",
      docsUrl: "https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create",
    }),
    provider({
      id: "wan-video-v1",
      capability: "asset.prepare",
      label: "百炼 · 通义万相视频",
      available: wanAvailable,
      kind: "external",
      billing: "metered",
      status: wanAvailable ? "ready" : "needs_config",
      description: "阿里云 Model Studio 异步视频生成；实际选中镜头逐项报价并等待人工确认。",
      modes: ["文生视频", "9:16", "720P", "2-15 秒"],
      deliveryTypes: assetProviderDeliveryTypes("wan-video-v1"),
      latency: "minutes",
      ...(wanSettings ? { estimatedCnyPerClip: wanSettings.estimatedCnyPerClip } : {}),
      defaultModelId: wanSettings?.model ?? (environment.WAN_MODEL_ID?.trim() || DEFAULT_WAN_VIDEO_MODEL_ID),
      modelProfiles: (wanSettings?.models ?? reviewedVideoModels["wan-video-v1"]).map((model) => ({
        ...model,
        providerId: "wan-video-v1",
        providerFamily: "dashscope-video",
        available: wanAvailable,
        description: "当前阿里云 Model Studio 视频模型，按镜头调用。",
      })),
      requirement: "需要 DASHSCOPE_API_KEY、DASHSCOPE_WORKSPACE_ID、WAN_MODEL_ID 和 WAN_ESTIMATED_CNY_PER_CLIP",
      docsUrl: "https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference",
    }),
    plannedVideoProvider("kling-video-v1", "Kling 可灵", "可灵官方 API 的模型目录与鉴权适配将在账号权限确认后启用。"),
    plannedVideoProvider("vidu-video-v1", "Vidu", "参考生视频、模板和口型能力将在统一生成任务协议上接入。"),
    provider({
      id: "minimax-tts-v1",
      capability: "voice.synthesize",
      label: "MiniMax 中文声音演员",
      available: miniMaxTtsAvailable,
      kind: "external",
      billing: "metered",
      approvalPolicy: "automatic",
      status: miniMaxTtsAvailable ? "ready" : "needs_config",
      description: "使用 speech-2.8-turbo 合成自然中文旁白，逐场缓存后再由 FFmpeg 做响度与节奏统一。",
      modes: ["普通话", "多角色", "情绪与语速", "云端生成"],
      latency: "seconds",
      estimatedCnyPerClip: positiveEstimate(environment.MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP, 0.5),
      billingUnit: "run",
      defaultModelId: environment.MINIMAX_TTS_MODEL_ID?.trim() || "speech-2.8-turbo",
      modelProfiles: [textModelProfile(environment.MINIMAX_TTS_MODEL_ID?.trim() || "speech-2.8-turbo", "MiniMax Speech 2.8 Turbo", "minimax-tts-v1", "minimax", miniMaxTtsAvailable, "云端中文配音模型；费用按一条视频的旁白保守估算。", positiveEstimate(environment.MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP, 0.5))],
      requirement: "需要 MINIMAX_API_KEY，可选 MINIMAX_TTS_MODEL_ID",
      docsUrl: "https://platform.minimaxi.com/docs/api-reference/speech-t2a-http",
    }),
    provider({
      id: "macos-say-v1",
      capability: "voice.synthesize",
      label: "macOS 系统配音",
      available: runtime.python && runtime.say,
      kind: "local",
      description: "系统内置中文语音，零 API 成本，适合日更验证。",
      modes: ["中文旁白", "本地生成"],
      latency: "seconds",
      requirement: "需要 macOS say",
    }),
    provider({
      id: "ffmpeg-tone-test-v1",
      capability: "voice.synthesize",
      label: "测试音轨",
      available: runtime.ffmpeg,
      kind: "test",
      description: "仅验证音视频链路，不参与正式生产。",
      modes: ["测试"],
      latency: "instant",
      requirement: "仅用于测试",
    }),
    provider({
      id: "volcengine-omnihuman-v1",
      capability: "avatar.generate",
      label: "OmniHuman 数字人表演",
      available: false,
      kind: "external",
      status: "planned",
      billing: "metered",
      description: "把已确认的人物图片和最终旁白合成为口型、表情与动作同步的数字人口播片段；它属于配音后的独立表演节点，不与普通文生视频模型混用。",
      modes: ["单图加音频", "口型同步", "真人与动漫形象", "异步生成"],
      latency: "minutes",
      defaultModelId: "omnihuman-1.5",
      modelProfiles: [{
        id: "omnihuman-1.5",
        label: "OmniHuman 1.5",
        providerId: "volcengine-omnihuman-v1",
        providerFamily: "volcengine-cv",
        available: false,
        recommended: true,
        description: "火山视觉内容生成服务的单图音频驱动模型；接入后只在用户选择数字人口播模板时启用。",
        taskTypes: ["digital-human"],
      }],
      requirement: "需要火山引擎 CV 服务 AK/SK、OmniHuman 权限和可供服务端拉取的图片/音频临时地址；现有 ARK_API_KEY 不能替代这些条件",
      docsUrl: "https://api.volcengine.com/api-docs/?serviceCode=cv&version=2024-06-06",
    }),
    provider({
      id: "python-ffmpeg-v1",
      capability: "video.render",
      label: "FFmpeg 竖屏渲染",
      available: runtime.python && runtime.ffmpeg,
      kind: "local",
      description: "本地确定性合成、字幕和音轨封装。",
      modes: ["1080×1920", "字幕", "本地渲染"],
      latency: "seconds",
      requirement: "需要 python3 和 ffmpeg",
    }),
    provider({
      id: "python-technical-review-v1",
      capability: "quality.review",
      label: "本地机器质检",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe,
      kind: "local",
      description: "检查分辨率、时长、轨道、素材完整性和产物哈希。",
      modes: ["技术门禁", "产物校验"],
      latency: "seconds",
      requirement: "需要 python3、ffmpeg 和 ffprobe",
    }),
    provider({
      id: "glm-visual-review-v1",
      capability: "quality.review.visual",
      label: "GLM-5.3-Flash 视觉审片",
      available: zaiVisualReviewAvailable,
      kind: "external",
      billing: "subscription",
      approvalPolicy: "none",
      description: `从成片中抽取带时间码的关键帧，使用用户的 Code Plan 调用 ${zaiModelLabel}，检查构图、连续性、节奏、文字可读性与内容安全。`,
      modes: ["原生多模态", "关键帧审片", "时间码问题", "Code Plan"],
      latency: "seconds",
      defaultModelId: zaiModelId,
      modelProfiles: [{
        id: zaiModelId,
        label: zaiModelLabel,
        providerId: "glm-visual-review-v1",
        providerFamily: "zai-bigmodel",
        available: zaiVisualReviewAvailable,
        recommended: true,
        description: "抽取成片关键帧后执行多模态视觉审片，使用用户的 Code Plan 额度。",
        taskTypes: ["visual-review"],
      }],
      requirement: zaiVisualReviewRequirement,
    }),
    provider({
      id: "codex-visual-review-v1",
      capability: "quality.review.visual",
      label: "Codex 视觉审片",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe && supportsTask(codex, "visual-review"),
      kind: "external",
      billing: "subscription",
      description: "从成片中安全抽取最多 12 张关键帧，由服务器 Codex 检查构图、连续性、节奏、文字可读性与内容安全。",
      modes: ["关键帧审片", "时间码问题", "修改建议", "订阅能力"],
      latency: "seconds",
      defaultModelId: modelForTask("visual-review"),
      modelProfiles: codexProfiles(
        "codex-visual-review-v1",
        "visual-review",
        "visual-review",
        runtime.python && runtime.ffmpeg && runtime.ffprobe,
      ),
      requirement: codexRequirement("visual-review"),
    }),
    provider({
      id: "codex-publish-copy-v1",
      capability: "publish.copy",
      label: "Codex 发行编辑",
      available: supportsTask(codex, "publish-copy"),
      kind: "external",
      billing: "subscription",
      description: "人工终审通过后为成片生成平台标题、描述与话题标签；不可用时发布包回退使用简报标题并如实标注来源。",
      modes: ["平台标题", "发布描述", "话题标签"],
      latency: "seconds",
      defaultModelId: modelForTask("publish-copy"),
      modelProfiles: codexProfiles("codex-publish-copy-v1", "publish-copy"),
      requirement: codexRequirement("publish-copy"),
    }),
    provider({
      id: "codex-role-auditor-v1",
      capability: "role.audit",
      label: "Codex 独立质量审计",
      available: supportsTask(codex, "role-audit"),
      kind: "external",
      billing: "subscription",
      description: "与生产角色隔离，逐条核对上下文、角色合同和下游边界；发现阻断问题时要求原角色修订。",
      modes: ["独立会话", "xhigh 推理", "最多三轮", "阻断门禁"],
      latency: "seconds",
      defaultModelId: modelForTask("role-audit"),
      modelProfiles: codexProfiles("codex-role-auditor-v1", "role-audit"),
      requirement: codexRequirement("role-audit"),
    }),
  ];
}

export function buildTrendSourceCatalog(
  environment: NodeJS.ProcessEnv,
  localServices: StudioTrendService[] = [],
): StudioTrendSource[] {
  const douyinCredentialsConfigured =
    environment.DOUYIN_HOTSEARCH_ENABLED === "1" && Boolean(environment.DOUYIN_CLIENT_TOKEN);
  const localReady = (id: StudioTrendService["id"]) => localServices.some((service) => service.id === id && service.status === "ready");
  return [
    {
      id: "manual-research",
      label: "人工研究",
      kind: "native",
      status: "ready",
      description: "录入已经人工核验的热点、搜索词或评论信号。",
      cadence: "随时",
    },
    {
      id: "json-import",
      label: "结构化 JSON",
      kind: "import",
      status: "ready",
      description: "批量导入带来源声明、时间和证据链接的结构化信号。",
      cadence: "按需",
    },
    {
      id: "trendradar-import",
      label: "TrendRadar 自托管",
      kind: "import",
      status: localReady("trendradar") ? "ready" : "needs_config",
      description: "本地聚合中文热榜、RSS、排名轨迹与历史 SQLite，并为 Agent 提供 MCP 分析入口。",
      cadence: "建议 30 分钟",
      requirement: localReady("trendradar") ? "本地采集器与 Web 报告已通过健康检查" : "运行 make setup-local-trends",
      docsUrl: "https://github.com/sansan0/TrendRadar",
    },
    {
      id: "newsnow-import",
      label: "NewsNow 自托管",
      kind: "import",
      status: localReady("newsnow") ? "ready" : "needs_config",
      description: "本地热点快照接口，提供微博、知乎、B 站、财经与中文新闻源。",
      cadence: "建议 30 分钟",
      requirement: localReady("newsnow") ? "本地 API 已接入统一热点网关" : "运行 make setup-local-trends",
      docsUrl: "https://github.com/ourongxing/newsnow",
    },
    {
      id: "dailyhot-import",
      label: "DailyHotApi",
      kind: "import",
      status: localReady("dailyhot") ? "ready" : "needs_config",
      description: "本地统一 JSON / RSS 热榜接口，补充抖音、微博、快手、百度和垂类榜单。",
      cadence: "建议 30-60 分钟",
      requirement: localReady("dailyhot") ? "本地 API 已接入统一热点网关" : "运行 make setup-local-trends",
      docsUrl: "https://github.com/imsyy/DailyHotApi",
    },
    {
      id: "rsshub-import",
      label: "RSSHub 中文世界",
      kind: "import",
      status: localReady("rsshub") ? "ready" : "needs_config",
      description: "补充港台、新马、海外中文媒体和垂直社区，不把新闻更新误当成平台热度。",
      cadence: "按 Feed 更新",
      requirement: localReady("rsshub") ? "本地 RSS 路由服务已通过健康检查" : "运行 make setup-local-trends",
      docsUrl: "https://docs.rsshub.app/deploy/",
    },
    {
      id: "douyin-hotsearch",
      label: "抖音官方热点",
      kind: "native",
      status: "needs_config",
      description: "官方热点权限可作为后续数据源；当前版本尚未实现自动采集适配器。",
      cadence: "约 2 小时",
      requirement: douyinCredentialsConfigured
        ? "已检测到授权配置；仍需实现并验证官方热点采集适配器"
        : "需要获批 hotsearch scope、配置授权，并实现官方热点采集适配器",
      docsUrl: "https://developer.open-douyin.com/capacity-center-page/capacity-detail/7180573594794065975",
    },
    {
      id: "newrank-import",
      label: "新榜数据",
      kind: "commercial",
      status: "manual_only",
      description: "在商业 API 合同确定前，以 CSV/JSON 导入保存来源边界。",
      cadence: "按购买方案",
      requirement: "需要商业数据授权",
      docsUrl: "https://data.newrank.cn/",
    },
    {
      id: "ocean-engine-import",
      label: "巨量算数",
      kind: "import",
      status: "manual_only",
      description: "用于人工研究关键词趋势，暂不假设存在可公开自动调用的 API。",
      cadence: "人工观察",
      docsUrl: "https://www.oceanengine.com/insight/juliang-suanshu-yidongduan",
    },
  ];
}

function supportsTask(availability: CodexCatalogAvailability, taskKind: string): boolean {
  return availability.available
    && (availability.taskKinds === undefined || availability.taskKinds.includes(taskKind));
}

function providerTaskRequirement(
  baseRequirement: string,
  availability: CodexCatalogAvailability,
  taskKind: string,
): string {
  if (availability.reason) return `${baseRequirement} 当前：${availability.reason}`;
  if (availability.available && availability.taskKinds !== undefined && !availability.taskKinds.includes(taskKind)) {
    return `${baseRequirement} 当前 broker 尚未提供 '${taskKind}' 任务能力。`;
  }
  return baseRequirement;
}

function provider(input: Omit<StudioProvider, "status" | "billing"> & Partial<Pick<StudioProvider, "status" | "billing">>): StudioProvider {
  const status = input.status ?? (input.available ? "ready" : "needs_config");
  const value: StudioProvider = {
    ...input,
    status,
    billing: input.billing ?? "free",
  };
  if (input.available && input.kind !== "test") {
    delete value.requirement;
  }
  return value;
}

function positiveEstimate(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function textModelProfile(
  id: string,
  label: string,
  providerId: string,
  providerFamily: string,
  available: boolean,
  description: string,
  estimatedCnyPerClip?: number,
): NonNullable<StudioProvider["modelProfiles"]>[number] {
  return {
    id,
    label,
    providerId,
    providerFamily,
    available,
    recommended: true,
    description,
    taskTypes: ["text"],
    ...(estimatedCnyPerClip !== undefined ? { estimatedCnyPerClip } : {}),
  };
}

// 同步调用无法核对 /health 协议，必须保守地报告不可用；生产启动路径会注入异步健康探测结果。
function probeCodexSynchronously(environment: NodeJS.ProcessEnv): CodexCatalogAvailability {
  const resolution = resolveCodexSocketPath(environment);
  return {
    available: false,
    reason: `尚未对 Codex bridge socket '${resolution.socketPath}' 完成协议健康检查。`,
  };
}

function plannedVideoProvider(id: string, label: string, description: string): StudioProvider {
  return provider({
    id,
    capability: "asset.prepare",
    label,
    available: false,
    kind: "external",
    status: "planned",
    billing: "metered",
    description,
    modes: ["视频生成", "统一任务协议"],
    deliveryTypes: assetProviderDeliveryTypes(id),
    latency: "minutes",
    requirement: "适配器尚未启用",
  });
}
