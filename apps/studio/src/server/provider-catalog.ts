import type { StudioProvider, StudioTrendService, StudioTrendSource } from "../shared/api.js";
import {
  resolveCodexSocketPath,
  resolveZaiCodexSocketPath,
  type CodexProviderSettings,
} from "./codex-provider-settings.js";
import { readMeteredVideoProviderSettings } from "./video-provider-settings.js";
import { readMeteredImageProviderSettings } from "./image-provider-settings.js";

export interface ProviderRuntime {
  python: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  say: boolean;
}

export type CodexCatalogAvailability = Pick<CodexProviderSettings, "available" | "reason"> & {
  taskKinds?: readonly string[];
};

export function buildProviderCatalog(
  runtime: ProviderRuntime,
  environment: NodeJS.ProcessEnv,
  codexAvailability?: CodexCatalogAvailability,
  zaiCodexAvailability?: CodexCatalogAvailability,
): StudioProvider[] {
  const videoSettings = readMeteredVideoProviderSettings(environment);
  const imageSettings = readMeteredImageProviderSettings(environment);
  const seedreamSettings = imageSettings.find((setting) => setting.providerId === "seedream-image-v1");
  const seedanceSettings = videoSettings.find((setting) => setting.providerId === "seedance-video-v1");
  const miniMaxSettings = videoSettings.find((setting) => setting.providerId === "hailuo-video-v1");
  const wanSettings = videoSettings.find((setting) => setting.providerId === "wan-video-v1");
  const seedanceAvailable = runtime.python && seedanceSettings !== undefined;
  const seedreamAvailable = runtime.python && seedreamSettings !== undefined;
  const miniMaxAvailable = runtime.python && miniMaxSettings !== undefined;
  const wanAvailable = runtime.python && wanSettings !== undefined;
  const codex = codexAvailability ?? probeCodexSynchronously(environment);
  const codexRequirement = (taskKind: string) => providerTaskRequirement(resolveCodexSocketPath(environment).requirement, codex, taskKind);
  const zaiCodex = zaiCodexAvailability ?? { available: false, reason: "尚未完成独立 broker 协议健康检查。" };
  const zaiCodexRequirement = providerTaskRequirement(resolveZaiCodexSocketPath(environment).requirement, zaiCodex, "visual-review");

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
      requirement: codexRequirement("topic-ideas"),
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
      requirement: codexRequirement("script-draft"),
    }),
    provider({
      id: "api-visual-director-v1",
      capability: "storyboard.plan",
      label: "Codex 视觉导演",
      available: supportsTask(codex, "director-plan"),
      kind: "external",
      billing: "subscription",
      description: "生成视觉圣经，并根据叙事、真实性、连续性和预算逐镜选择素材来源。",
      modes: ["导演角色", "视觉圣经", "逐镜路由"],
      latency: "seconds",
      requirement: codexRequirement("director-plan"),
    }),
    provider({
      id: "codex-reference-grammar-v1",
      capability: "reference.grammar",
      label: "Codex 参考视频分析",
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe && supportsTask(codex, "reference-grammar"),
      kind: "external",
      billing: "subscription",
      description: "安全抽取参考视频关键帧，只提炼节奏、构图、运镜、色彩、转场和声音结构等制作语法。",
      modes: ["关键帧分析", "镜头语法", "可编辑规则", "订阅能力"],
      latency: "seconds",
      requirement: codexRequirement("reference-grammar"),
    }),
    provider({
      id: "codex-asset-ranker-v1",
      capability: "asset.rank.semantic",
      label: "Codex 语义选片",
      available: supportsTask(codex, "asset-rank"),
      kind: "external",
      billing: "subscription",
      description: "在下载前依据逐镜意图重排图库候选；不可用时保留确定性原始排序。",
      modes: ["候选排序", "逐项理由", "人工锁定", "订阅能力"],
      latency: "seconds",
      requirement: codexRequirement("asset-rank"),
    }),
    provider({
      id: "ai-shot-router-v1",
      capability: "asset.prepare",
      label: "AI 逐镜路由",
      available: runtime.python && supportsTask(codex, "director-plan"),
      kind: "external",
      description: "执行导演计划；每个镜头可独立调用本地、图库或图片及视频生成能力。",
      modes: ["逐镜决策", "多来源", "预算门禁"],
      latency: "seconds",
      requirement: "需要 Python 和 Codex 视觉导演",
    }),
    provider({
      id: "local-editorial-v1",
      capability: "asset.prepare",
      label: "本地编辑卡片",
      available: runtime.python,
      kind: "local",
      description: "自有排版卡片与本地画面，版权清晰，是经济日更的稳定底座。",
      modes: ["9:16", "自有素材", "零 API"],
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
      latency: "seconds",
      ...(seedreamSettings ? { estimatedCnyPerClip: seedreamSettings.estimatedCnyPerImage } : {}),
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
      description: "通过同一个火山方舟协议调用可配置的视频模型，只用于预算内的少量关键镜头。",
      modes: ["文生视频", "9:16", "2-15 秒", "无声素材"],
      latency: "minutes",
      ...(seedanceSettings ? { estimatedCnyPerClip: seedanceSettings.estimatedCnyPerClip } : {}),
      ...(seedanceSettings ? {
        defaultModelId: seedanceSettings.model,
        modelProfiles: seedanceSettings.models.map((model) => ({
          ...model,
          providerId: "seedance-video-v1",
          providerFamily: "ark-video",
          available: true,
          description: model.recommended
            ? "当前推荐的方舟视频模型，适合精品关键镜头与受控小额验证。"
            : "同一方舟 API 下的可选视频模型，可按项目或节点覆盖默认值。",
        })),
      } : {}),
      requirement: "需要 ARK_API_KEY 和 SEEDANCE_ESTIMATED_CNY_PER_CLIP；模型可在页面配置",
      docsUrl: "https://www.volcengine.com/docs/82379/1520757?lang=zh",
    }),
    provider({
      id: "hailuo-video-v1",
      capability: "asset.prepare",
      label: "MiniMax 海螺关键镜头",
      available: miniMaxAvailable,
      kind: "external",
      billing: "metered",
      status: miniMaxAvailable ? "ready" : "needs_config",
      description: "MiniMax 海螺异步视频生成，适合需要明确运镜的少量表现镜头。",
      modes: ["文生视频", "768P", "6 秒", "成片裁切为 9:16"],
      latency: "minutes",
      ...(miniMaxSettings ? { estimatedCnyPerClip: miniMaxSettings.estimatedCnyPerClip } : {}),
      requirement: "需要 MINIMAX_API_KEY、MINIMAX_VIDEO_MODEL_ID 和 MINIMAX_ESTIMATED_CNY_PER_CLIP",
      docsUrl: "https://platform.minimaxi.com/docs/api-reference/video-generation-t2v",
    }),
    provider({
      id: "wan-video-v1",
      capability: "asset.prepare",
      label: "Wan 关键镜头",
      available: wanAvailable,
      kind: "external",
      billing: "metered",
      status: wanAvailable ? "ready" : "needs_config",
      description: "阿里云 Model Studio 异步视频生成，按预算生成关键镜头。",
      modes: ["文生视频", "9:16", "720P", "2-15 秒"],
      latency: "minutes",
      ...(wanSettings ? { estimatedCnyPerClip: wanSettings.estimatedCnyPerClip } : {}),
      requirement: "需要 DASHSCOPE_API_KEY、DASHSCOPE_WORKSPACE_ID、WAN_MODEL_ID 和 WAN_ESTIMATED_CNY_PER_CLIP",
      docsUrl: "https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference",
    }),
    plannedVideoProvider("kling-video-v1", "Kling 可灵", "可灵官方 API 的模型目录与鉴权适配将在账号权限确认后启用。"),
    plannedVideoProvider("vidu-video-v1", "Vidu", "参考生视频、模板和口型能力将在统一生成任务协议上接入。"),
    provider({
      id: "minimax-tts-v1",
      capability: "voice.synthesize",
      label: "MiniMax 中文声音演员",
      available: runtime.python && runtime.ffmpeg && Boolean(environment.MINIMAX_API_KEY),
      kind: "external",
      billing: "metered",
      status: runtime.python && runtime.ffmpeg && Boolean(environment.MINIMAX_API_KEY) ? "ready" : "needs_config",
      description: "使用 speech-2.8-turbo 合成自然中文旁白，逐场缓存后再由 FFmpeg 做响度与节奏统一。",
      modes: ["普通话", "多角色", "情绪与语速", "云端生成"],
      latency: "seconds",
      estimatedCnyPerClip: positiveEstimate(environment.MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP, 0.5),
      billingUnit: "run",
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
      available: runtime.python && runtime.ffmpeg && runtime.ffprobe && supportsTask(zaiCodex, "visual-review"),
      kind: "external",
      billing: "metered",
      estimatedCnyPerClip: positiveEstimate(environment.ZAI_VISUAL_REVIEW_ESTIMATED_CNY, 0.1),
      billingUnit: "run",
      description: "从成片中抽取带时间码的关键帧，通过普通 BigModel API 调用 GLM-5.3-Flash，检查构图、连续性、节奏、文字可读性与内容安全。",
      modes: ["原生多模态", "关键帧审片", "时间码问题", "按量 API"],
      latency: "seconds",
      requirement: zaiCodexRequirement,
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
      requirement: codexRequirement("publish-copy"),
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
    latency: "minutes",
    requirement: "适配器尚未启用",
  });
}
