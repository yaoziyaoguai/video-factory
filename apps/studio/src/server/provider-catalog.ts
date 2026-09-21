import type { StudioProvider, StudioTrendService, StudioTrendSource } from "../shared/api.js";
import {
  resolveCodexSocketPath,
  resolveDeepseekCodexSocketPath,
  resolveDeepseekModelId,
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
import { seedreamModelSupportsReferenceImage } from "@video-factory/production-pipeline";

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
  /** broker 公告的已审核候选模型；空或缺省表示它不接受任何按请求的模型覆盖。 */
  modelCandidates?: string[];
};

type AssetDeliveryType = NonNullable<StudioProvider["deliveryTypes"]>[number];

/**
 * 已经接上"按请求换模型"的角色：这些角色的候选 agent 是按 broker 公告的候选表逐个建出来的，
 * 选中哪一个都能真的把模型送上线路。
 *
 * 其余角色（审片、发行文案、选题总编……）仍然是一个 broker 一个候选 agent。对它们展开候选表
 * 会把一批"选中就报 Selected model '…' is not available for this role."的选项列进界面——
 * 比不列更糟。接完一个角色就往这里加一个，加满即删掉这个集合。
 *
 * 审片刻意不在这里：它的两个候选必须是两个不同模型（独立双审），而展开候选表会让用户把
 * DeepSeek 那条也选成 Codex 的同名模型，静默破坏那道不变量。它的兜底走的是跨 broker 的
 * FallbackVisualReviewAgent，不由这层负责。
 */
const MODEL_SWITCH_TASK_KINDS = new Set<string>([
  "script-draft",
  "creative-treatment",
  "director-plan",
  // 简报那一轮独立复核也是用户可选的：目录里只有 codex-role-auditor-v1 承载 role.audit，
  // 两个 broker 的候选模型都从这一个能力键下面选。
  "role-audit",
]);

const ASSET_PROVIDER_DELIVERY_TYPES = {
  "local-editorial-v1": ["editorial_card"],
  "pexels-stock-v1": ["stock_video", "stock_image"],
  "pixabay-stock-v1": ["stock_video", "stock_image"],
  "unsplash-stock-v1": ["stock_image"],
  "coverr-stock-v1": ["stock_video"],
  "wikimedia-stock-v1": ["stock_video", "stock_image"],
  "met-stock-v1": ["stock_image"],
  "cleveland-stock-v1": ["stock_image"],
  "archive-stock-v1": ["stock_video"],
  "flickr-stock-v1": ["stock_image"],
  "nasa-stock-v1": ["stock_image", "stock_video"],
  "openverse-stock-v1": ["stock_image"],
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

export function assetProviderSupportsReferenceImage(providerId: string, modelId?: string): boolean {
  if (providerId !== "seedream-image-v1") return false;
  return modelId === undefined || seedreamModelSupportsReferenceImage(modelId);
}

export function buildProviderCatalog(
  runtime: ProviderRuntime,
  environment: NodeJS.ProcessEnv,
  codexAvailability?: CodexCatalogAvailability,
  deepseekCodexAvailability?: CodexCatalogAvailability,
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
  ) => {
    const defaultModelId = modelForTask(taskKind);
    // broker 公告的候选表里每个模型都是一个真正能选用的模型：选了它就随请求声明给 broker，
    // broker 用它跑。默认模型始终在列表里，即使候选表还没收录它——broker 会把"请求的模型就是我"
    // 归一化成没有覆盖。公告为空时列表退化成只有默认模型那一项，与候选表引入之前完全一致。
    const selectable = [...new Set([
      defaultModelId,
      ...(MODEL_SWITCH_TASK_KINDS.has(taskKind) ? codex.modelCandidates ?? [] : []),
    ].filter((modelId) => modelId.trim()))];
    return selectable.map((modelId) => ({
      ...textModelProfile(
        modelId,
        modelId === "codex-default" ? "由 Codex 运行时决定" : modelId,
        "codex-broker",
        "openai",
        codex.available,
        modelId === "codex-default"
          ? "Codex broker 尚未报告具体模型；首次调用后会记录实际模型。"
          : MODEL_SWITCH_TASK_KINDS.has(taskKind)
            ? "服务器 Codex broker 已审核的模型；可在本次制作或单个节点上直接选用，不需要重启 broker。"
            : "服务器 Codex broker 针对此角色实际使用的模型；切换需要更新运行时配置并重启 broker。",
      ),
      recommended: modelId === defaultModelId,
      providerId,
      available: runtimeAvailable && supportsTask(codex, taskKind),
      taskTypes: [taskType],
    }));
  };
  const codexRequirement = (taskKind: string) => providerTaskRequirement(resolveCodexSocketPath(environment).requirement, codex, taskKind);
  const deepseekCodex = deepseekCodexAvailability ?? { available: false, reason: "尚未完成独立 broker 协议健康检查。" };
  const deepseekCodexRequirementFor = (taskKind: string) => providerTaskRequirement(resolveDeepseekCodexSocketPath(environment).requirement, deepseekCodex, taskKind);
  const deepseekTextModelId = deepseekCodex.modelId?.trim() || resolveDeepseekModelId(environment);
  const deepseekModelForTask = (taskKind: string) => deepseekCodex.taskModels?.[taskKind]?.trim() || deepseekTextModelId;
  const deepseekVisualModelId = deepseekCodex.taskModels?.["visual-review"]?.trim() || resolveDeepseekModelId(environment);
  const codexAuditAvailable = supportsTask(codex, "role-audit");
  const deepseekAuditAvailable = supportsTask(deepseekCodex, "role-audit");
  const codexRoleAvailable = (taskKind: string) => supportsTask(codex, taskKind) && codexAuditAvailable;
  const deepseekRoleAvailable = (taskKind: string) => supportsTask(deepseekCodex, taskKind) && deepseekAuditAvailable;
  /**
   * 这个 provider 给界面预置的模型。首选是 DeepSeek，DeepSeek 服务不了这个任务时才用 Codex。
   *
   * 这与 role-agent-assembly 的候选池顺序是同一条规则——那里的注释写着「顺序即默认：每个角色的
   * 池子都是 DeepSeek 在前、Codex 在后，所以「首选」是 DeepSeek」；也与下面 modelProfiles 里
   * 的 recommended 同源。三处必须一致，因为这个字段不只是显示：NewRunDialog 用它拼出新建制作的
   * initialInput.models，NodeWorkspace 与 PlanningStagesPanel 用它决定下拉默认选中哪个。
   * 三者不一致时，界面会给用户预置一台与"推荐"标签、与运行时真实首选都不同的模型。
   */
  const preferredModelFor = (taskKind: string) => (deepseekRoleAvailable(taskKind)
    ? deepseekModelForTask(taskKind)
    : modelForTask(taskKind));
  const deepseekProfiles = (
    providerId: string,
    taskKind: string,
    taskType: "text" | "visual-review" = "text",
    runtimeAvailable = true,
  ) => {
    const defaultModelId = deepseekModelForTask(taskKind);
    // 与 codexProfiles 同一条规则：broker 在 /health 公告的候选表里，每个模型都是
    // role-agent-assembly 真会建出候选 agent 的模型。目录少列一条，用户就既看不见那条兜底腿，
    // 也没法把它直接设成首选——而它照样会在首选故障时被自动用上。这两件事必须一致。
    const selectable = [...new Set([
      defaultModelId,
      ...(MODEL_SWITCH_TASK_KINDS.has(taskKind) ? deepseekCodex.modelCandidates ?? [] : []),
    ].filter((modelId) => modelId.trim()))];
    return selectable.map((modelId) => ({
      ...textModelProfile(
        modelId,
        modelId,
        providerId,
        "deepseek",
        runtimeAvailable && deepseekRoleAvailable(taskKind),
        modelId === defaultModelId
          ? "DeepSeek 首选模型；首选模型发生连接、超时、限流、容量或服务不可用时可作为候选，业务校验失败不会触发切换。"
          : "DeepSeek broker 公告的已审核候选，排在首选之后的兜底腿；也可在本次制作或单个节点上直接选为首选。",
      ),
      recommended: modelId === defaultModelId && deepseekRoleAvailable(taskKind),
      taskTypes: [taskType],
    }));
  };
  const roleModelProfiles = (
    providerId: string,
    taskKind: string,
    taskType: "text" | "visual-review" = "text",
    runtimeAvailable = true,
  ) => {
    const profiles = [
      ...deepseekProfiles(providerId, taskKind, taskType, runtimeAvailable),
      ...codexProfiles(providerId, taskKind, taskType, runtimeAvailable && codexAuditAvailable).map((model) => ({
        ...model,
        // 只有首选那一侧是推荐项；候选表里的其他模型是可选项，标成推荐会变成两个"默认"。
        recommended: model.recommended && !deepseekRoleAvailable(taskKind) && codexRoleAvailable(taskKind),
      })),
    ];
    // 两个 broker 公告同一个模型 id 时只留先出现的那条，顺序即偏好——这与 role-agent-assembly 的
    // distinctCandidates 是同一条规则。留着重复项只会让界面上出现两个同名选项。
    const seen = new Set<string>();
    return profiles.filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  };
  const roleRequirement = (taskKind: string) => deepseekRoleAvailable(taskKind) || codexRoleAvailable(taskKind)
    ? "至少一个能同时完成生产与独立质量复核的模型服务可用。"
    : `DeepSeek：${uniqueRequirements(deepseekCodexRequirementFor(taskKind), deepseekCodexRequirementFor("role-audit"))} OpenAI：${uniqueRequirements(codexRequirement(taskKind), codexRequirement("role-audit"))}`;
  const deepseekVisualProducerAvailable = supportsTask(deepseekCodex, "visual-review");
  const codexVisualProducerAvailable = supportsTask(codex, "visual-review");
  const deepseekVisualReviewAvailable = runtime.python
    && runtime.ffmpeg
    && runtime.ffprobe
    && deepseekVisualProducerAvailable
    && deepseekAuditAvailable;
  const deepseekVisualReviewRequirement = !deepseekVisualProducerAvailable
    ? deepseekCodexRequirementFor("visual-review")
    : !deepseekAuditAvailable
      ? `DeepSeek 审片意见必须经过独立质量复核。${deepseekCodexRequirementFor("role-audit")}`
      : deepseekCodexRequirementFor("visual-review");

  return [
    provider({
      id: "api-topic-editor-v1",
      capability: "topic.intelligence",
      label: "选题总编",
      available: codexRoleAvailable("topic-ideas") || deepseekRoleAvailable("topic-ideas"),
      kind: "external",
      billing: "subscription",
      description: "把实时热点转译为可拍摄、可连载的中文短视频角度；模型失败时明确标注规则推荐来源。",
      modes: ["热点理解", "选题提案", "结构化输出"],
      latency: "seconds",
      defaultModelId: preferredModelFor("topic-ideas"),
      modelProfiles: roleModelProfiles("api-topic-editor-v1", "topic-ideas"),
      requirement: roleRequirement("topic-ideas"),
    }),
    provider({
      id: "codex-series-showrunner-v1",
      capability: "series.plan",
      label: "系列主理人",
      available: codexRoleAvailable("series-roadmap") || deepseekRoleAvailable("series-roadmap"),
      kind: "external",
      billing: "subscription",
      description: "维护 Series Bible、Canon 与集间承接，规划长期路线并在单集开拍前重新复核。",
      modes: ["系列圣经", "连续性", "单集开拍复核", "最多三轮修订"],
      latency: "seconds",
      defaultModelId: preferredModelFor("series-roadmap"),
      modelProfiles: roleModelProfiles("codex-series-showrunner-v1", "series-roadmap"),
      requirement: roleRequirement("series-roadmap"),
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
      label: "AI 编剧",
      available: codexRoleAvailable("script-draft") || deepseekRoleAvailable("script-draft"),
      kind: "external",
      billing: "subscription",
      description: "按选题角度撰写可拍、可朗读、可核验的分镜脚本；首选模型调用故障时按候选顺序切换，内容校验或质量复核未通过时明确失败，不回退模板。",
      modes: ["口语旁白", "3-10 场分镜", "逐场画面指令"],
      latency: "seconds",
      defaultModelId: preferredModelFor("script-draft"),
      modelProfiles: roleModelProfiles("codex-screenwriter-v1", "script-draft"),
      requirement: roleRequirement("script-draft"),
    }),
    provider({
      id: "api-visual-director-v1",
      capability: "storyboard.plan",
      label: "视觉导演",
      available: codexRoleAvailable("director-plan") || deepseekRoleAvailable("director-plan"),
      kind: "external",
      billing: "subscription",
      description: "统一全片视觉规则，并根据叙事、真实性、连续性和可执行性逐镜选择画面来源；首选模型调用故障时按健康候选顺序切换。",
      modes: ["导演角色", "全片视觉规则", "逐镜选画面"],
      latency: "seconds",
      defaultModelId: preferredModelFor("director-plan"),
      modelProfiles: roleModelProfiles("api-visual-director-v1", "director-plan"),
      requirement: roleRequirement("director-plan"),
    }),
    provider({
      // B4：前期构思接入 joint-v1 正式生产图，目录登记构思能力卡片（模型选择/健康检查用）。
      id: "codex-creative-treatment-v1",
      capability: "creative.treatment",
      label: "AI 前期构思",
      available: codexRoleAvailable("creative-treatment") || deepseekRoleAvailable("creative-treatment"),
      kind: "external",
      billing: "subscription",
      description: "在脚本写定前确定观众承诺、开头吸引、推进与兑现，并标注素材可行性风险；首选模型调用故障时按健康候选顺序切换。",
      modes: ["观众承诺", "内容推进", "可行性风险", "订阅能力"],
      latency: "seconds",
      defaultModelId: preferredModelFor("creative-treatment"),
      modelProfiles: roleModelProfiles("codex-creative-treatment-v1", "creative-treatment"),
      requirement: roleRequirement("creative-treatment"),
    }),
    provider({
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "参考视频分析师",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe
        && (codexRoleAvailable("reference-grammar") || deepseekRoleAvailable("reference-grammar")),
      kind: "external",
      billing: "subscription",
      description: "安全抽取参考视频关键帧，只提炼节奏、构图、运镜、色彩、转场和声音结构等风格规则。",
      modes: ["关键帧分析", "镜头语法", "可编辑规则", "订阅能力"],
      latency: "seconds",
      defaultModelId: preferredModelFor("reference-grammar"),
      modelProfiles: roleModelProfiles(
        "codex-reference-grammar-v1",
        "reference-grammar",
        "visual-review",
        runtime.python && runtime.ffmpeg && runtime.ffprobe,
      ),
      requirement: roleRequirement("reference-grammar"),
    }),
    provider({
      id: "codex-asset-ranker-v1",
      capability: "asset.rank.semantic",
      label: "候选画面复核",
      available: codexRoleAvailable("asset-rank") || deepseekRoleAvailable("asset-rank"),
      kind: "external",
      billing: "subscription",
      description: "在下载前依据逐镜意图重排图库候选；不可用时保留确定性原始排序。",
      modes: ["候选排序", "逐项理由", "人工锁定", "订阅能力"],
      latency: "seconds",
      defaultModelId: preferredModelFor("asset-rank"),
      modelProfiles: roleModelProfiles("codex-asset-ranker-v1", "asset-rank"),
      requirement: roleRequirement("asset-rank"),
    }),
    provider({
      id: "ai-shot-router-v1",
      capability: "asset.prepare",
      label: "AI 逐镜路由",
      available: runtime.python && (codexRoleAvailable("director-plan") || deepseekRoleAvailable("director-plan")),
      kind: "external",
      description: "执行导演计划；每个镜头可独立调用本地、图库或图片及视频生成能力。",
      modes: ["逐镜决策", "多来源", "逐项报价"],
      latency: "seconds",
      requirement: "需要 Python 和可用的视觉导演模型",
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
      requirement: "需要连接 Pexels 图库服务",
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
      requirement: "需要连接 Pixabay 图库服务",
      docsUrl: "https://pixabay.com/api/docs/",
    }),
    provider({
      id: "unsplash-stock-v1",
      capability: "asset.prepare",
      label: "Unsplash 图片",
      available: runtime.python && Boolean(environment.UNSPLASH_ACCESS_KEY?.trim()),
      kind: "external",
      description: "免费摄影图片补充源，不提供视频。采用时保留作者署名并按官方要求上报下载。",
      modes: ["摄影图片", "竖屏搜索", "作者署名"],
      deliveryTypes: assetProviderDeliveryTypes("unsplash-stock-v1"),
      latency: "seconds",
      requirement: "需要 UNSPLASH_ACCESS_KEY；正式使用还需通过 Unsplash 应用审核和额度申请",
      docsUrl: "https://unsplash.com/documentation",
    }),
    provider({
      id: "flickr-stock-v1",
      capability: "asset.prepare",
      label: "Flickr 开放摄影图片",
      available: runtime.python && Boolean(environment.FLICKR_API_KEY?.trim()),
      kind: "external",
      description: "公开摄影图片，逐项核对开放许可和下载权限；采用前再次核验。",
      modes: ["摄影图片", "作者署名", "逐文件许可"],
      deliveryTypes: assetProviderDeliveryTypes("flickr-stock-v1"),
      latency: "seconds",
      requirement: "需要 FLICKR_API_KEY；仅图片，须遵守署名及非商业等许可条件",
      docsUrl: "https://www.flickr.com/services/api/",
    }),
    provider({
      id: "coverr-stock-v1",
      capability: "asset.prepare",
      label: "Coverr 视频",
      available: runtime.python && Boolean(environment.COVERR_API_KEY?.trim()),
      kind: "external",
      description: "免费 HD/4K 实拍视频补充源，采用时保留来源并使用官方正式下载链接。",
      modes: ["实拍视频", "横竖屏候选", "作者与来源"],
      deliveryTypes: assetProviderDeliveryTypes("coverr-stock-v1"),
      latency: "seconds",
      requirement: "需要 COVERR_API_KEY；Demo 免费额度为每小时 50 次请求",
      docsUrl: "https://api.coverr.co/docs/",
    }),
    provider({
      id: "wikimedia-stock-v1",
      capability: "asset.prepare",
      label: "Wikimedia 图片与视频",
      available: runtime.python,
      kind: "external",
      description: "无需 Key 的图片与视频，补充城市、自然与文化素材；保留作者及逐文件许可。",
      modes: ["图片与视频", "作者署名", "逐文件许可"],
      deliveryTypes: assetProviderDeliveryTypes("wikimedia-stock-v1"),
      latency: "seconds",
      requirement: "需要 Python 与 Wikimedia 网络连通；无需 API Key。素材许可、清晰度与体积须满足要求",
      docsUrl: "https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia",
    }),
    ...[
      { id: "met-stock-v1", label: "Met 开放馆藏图片", description: "无需 Key 的开放馆藏图片，补充绘画、器物与历史文化；仅采用开放图像子集。", docsUrl: "https://metmuseum.github.io/" },
      { id: "cleveland-stock-v1", label: "Cleveland 开放馆藏图片", description: "无需 Key 的 CC0 高清馆藏图片，含中国绘画、玉器、陶瓷；不是现代生活视频库。", docsUrl: "https://www.clevelandart.org/open-access" },
      { id: "archive-stock-v1", label: "Internet Archive 开放视频", description: "无需 Key 的开放许可实拍片段；限定 stock_footage 集合，逐项核对许可、高清与体积，非全站内容都可用。", docsUrl: "https://archive.org/details/stock_footage" },
      { id: "nasa-stock-v1", label: "NASA 科学图片与视频", description: "无需 Key 的科学、航天和地球观测素材；不是通用生活图库，须保留来源并核对第三方权利。", docsUrl: "https://images.nasa.gov/" },
      { id: "openverse-stock-v1", label: "Openverse 开放图片", description: "无需 Key 的图片聚合检索；不提供视频，保留原站与许可，允许符合条件的非商业素材。", docsUrl: "https://docs.openverse.org/" },
    ].map((source) => provider({
      ...source, capability: "asset.prepare", available: runtime.python && (!["nasa-stock-v1", "archive-stock-v1"].includes(source.id) || runtime.ffprobe),
      kind: "external", modes: ["免费素材", "无需 Key", "来源与许可"],
      deliveryTypes: assetProviderDeliveryTypes(source.id), latency: "seconds",
      requirement: "无需 API Key；需要 Python、媒体处理工具和来源网络连通。已安装不代表当前网络或配额可用。",
    })),
    provider({
      id: "seedream-image-v1",
      capability: "asset.prepare",
      label: "Seedream 关键画面",
      available: seedreamAvailable,
      kind: "external",
      billing: "metered",
      status: seedreamAvailable ? "ready" : "needs_config",
      description: "火山方舟同步生成竖屏关键画面，适合解释性插画、概念视觉和系列统一风格。",
      modes: [
        "文生图",
        ...(seedreamSettings && assetProviderSupportsReferenceImage("seedream-image-v1", seedreamSettings.model)
          ? ["参考图再生成"]
          : []),
        "9:16",
        "单张关键画面",
      ],
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
      requirement: "需要连接火山方舟账号；模型与单图估价未单独设置时使用已审核的保守默认值",
      docsUrl: "https://api.volcengine.com/api-docs/view?action=ImageGenerations&serviceCode=ark&version=2024-01-01",
      consoleUrl: "https://console.volcengine.com/ark",
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
      requirement: "需要连接火山方舟账号，并为视频模型配置单镜头估价；模型可在页面选择",
      docsUrl: "https://www.volcengine.com/docs/82379/1520757?lang=zh",
      consoleUrl: "https://console.volcengine.com/ark",
    }),
    provider({
      id: "hailuo-video-v1",
      capability: "asset.prepare",
      label: "MiniMax 视频生成",
      available: miniMaxAvailable,
      kind: "external",
      billing: "metered",
      status: miniMaxAvailable ? "ready" : "needs_config",
      description: "同一个 MiniMax 服务中可选择 Hailuo 或 H3；H3 支持 4–15 秒、原生音画与最高 2K。",
      modes: ["文生视频", "4–15 秒", "最高 2K", "逐镜可选模型"],
      deliveryTypes: assetProviderDeliveryTypes("hailuo-video-v1"),
      latency: "minutes",
      ...(miniMaxSettings ? { estimatedCnyPerClip: miniMaxSettings.estimatedCnyPerClip } : {}),
      defaultModelId: miniMaxSettings?.model
        ?? reviewedVideoModels["hailuo-video-v1"].find((model) => model.recommended)?.id
        ?? DEFAULT_MINIMAX_VIDEO_MODEL_ID,
      modelProfiles: (miniMaxSettings?.models ?? reviewedVideoModels["hailuo-video-v1"]).map((model) => ({
        ...model,
        providerId: "hailuo-video-v1",
        providerFamily: "minimax-video",
        available: miniMaxAvailable,
        description: !model.aspectRatios.includes("9:16")
          ? `${model.label} 当前接口只能可靠交付横屏，不能用于本项目的 9:16 成片。请改选 MiniMax H3 系列。`
          : model.estimatedCnyByResolutionAndDuration
          ? `${model.label} 固定规格：768P 6 秒 ¥2、10 秒 ¥4；1080P 仅 6 秒 ¥3.5。实际选中镜头逐项报价并等待人工确认。`
          : model.estimatedCnyPerSecond
            ? `${model.label} 按时长与分辨率计费，默认规格约 ¥${model.estimatedCnyPerSecond.toFixed(2)}/秒；执行前按实际镜头重新核算。`
            : "MiniMax Hailuo 固定规格视频模型；实际选中镜头逐项报价并等待人工确认。",
      })),
      requirement: "需要连接 MiniMax 账号并选择已审核的视频模型；系统会按所选规格逐镜报价",
      docsUrl: "https://platform.minimaxi.com/docs/api-reference/video-generation-v2-create",
      consoleUrl: "https://platform.minimaxi.com/",
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
        description: "当前接入文生视频、720P、2–15 秒，按 ¥0.60/秒逐镜报价；模型其他输入方式与更长时长尚未接入。",
      })),
      requirement: "需要连接阿里云百炼账号及工作空间，并选择当前已接入的视频模型",
      docsUrl: "https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference",
      consoleUrl: "https://bailian.console.aliyun.com/",
    }),
    plannedVideoProvider("kling-video-v1", "Kling 可灵", "可灵官方接口的模型目录与鉴权适配将在账号权限确认后启用。"),
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
      requirement: "需要连接 MiniMax 账号；未单独选择配音模型时使用已审核的默认模型",
      docsUrl: "https://platform.minimaxi.com/docs/api-reference/speech-t2a-http",
      consoleUrl: "https://platform.minimaxi.com/",
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
      requirement: "需要开通火山引擎视觉内容生成服务与 OmniHuman 权限，并准备可访问的图片和音频地址；普通方舟模型权限不能替代",
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
      modes: ["技术检查", "文件校验"],
      latency: "seconds",
      requirement: "需要 python3、ffmpeg 和 ffprobe",
    }),
    provider({
      id: "deepseek-visual-review-v1",
      capability: "quality.review.visual",
      label: "视觉审片员",
      available: deepseekVisualReviewAvailable,
      kind: "external",
      billing: "subscription",
      approvalPolicy: "none",
      description: `从成片中抽取带时间码的关键帧，调用 ${deepseekVisualModelId}，检查构图、连续性、节奏、文字可读性与内容安全。`,
      modes: ["原生多模态", "关键帧审片", "时间码问题", "订阅额度"],
      latency: "seconds",
      defaultModelId: deepseekVisualModelId,
      modelProfiles: [{
        id: deepseekVisualModelId,
        label: deepseekVisualModelId,
        providerId: "deepseek-visual-review-v1",
        providerFamily: "deepseek",
        available: deepseekVisualReviewAvailable,
        recommended: true,
        description: "抽取成片关键帧后执行多模态视觉审片，使用 DeepSeek 订阅额度。",
        taskTypes: ["visual-review"],
      }],
      requirement: deepseekVisualReviewRequirement,
    }),
    provider({
      id: "codex-visual-review-v1",
      capability: "quality.review.visual",
      label: "旧版视觉审片（已退役）",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe && codexVisualProducerAvailable && codexAuditAvailable,
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
        runtime.python && runtime.ffmpeg && runtime.ffprobe && codexAuditAvailable,
      ),
      requirement: !codexVisualProducerAvailable
        ? codexRequirement("visual-review")
        : !codexAuditAvailable
          ? `Codex 审片意见必须经过独立质量复核。${codexRequirement("role-audit")}`
          : codexRequirement("visual-review"),
    }),
    provider({
      id: "codex-publish-copy-v1",
      capability: "publish.copy",
      label: "发行编辑",
      available: codexRoleAvailable("publish-copy") || deepseekRoleAvailable("publish-copy"),
      kind: "external",
      billing: "subscription",
      description: "人工终审通过后为成片生成平台标题、描述与话题标签；不可用时发布包回退使用简报标题并如实标注来源。",
      modes: ["平台标题", "发布描述", "话题标签"],
      latency: "seconds",
      defaultModelId: preferredModelFor("publish-copy"),
      modelProfiles: roleModelProfiles("codex-publish-copy-v1", "publish-copy"),
      requirement: roleRequirement("publish-copy"),
    }),
    provider({
      id: "codex-role-auditor-v1",
      capability: "role.audit",
      label: "AI 独立质量复核",
      available: codexAuditAvailable || deepseekAuditAvailable,
      kind: "external",
      billing: "subscription",
      description: "由独立 AI 核对创作依据、角色要求和后续能否直接使用；发现必须修改的问题时，交回原角色修订。",
      modes: ["独立复核", "深入核对", "最多三轮", "不通过则要求修改"],
      latency: "seconds",
      defaultModelId: preferredModelFor("role-audit"),
      modelProfiles: roleModelProfiles("codex-role-auditor-v1", "role-audit"),
      requirement: roleRequirement("role-audit"),
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

function uniqueRequirements(...requirements: string[]): string {
  return [...new Set(requirements)].join(" ");
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
