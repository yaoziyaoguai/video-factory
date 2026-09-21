import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  GenerativeAssetWorkerClient,
  MiniMaxVideoAdapter,
  PythonWorkerClient,
  SeedreamImageAdapter,
  SeedanceVideoAdapter,
  WanVideoAdapter,
  SourceAssetPilotReviewer,
  type VisualReviewAgent,
  type VisualAssetProviderCapability,
  type ImageGenerationAdapterBinding,
  type GeneratedMediaMetadata,
  type ProductionProviderRuntimeMetadata,
  type VideoGenerationAdapterBinding,
} from "@video-factory/production-pipeline";
import { readMeteredVideoProviderSettings } from "./video-provider-settings.js";
import { readMeteredImageProviderSettings } from "./image-provider-settings.js";
import { resolveDeepseekModelId } from "./codex-provider-settings.js";
import { assetProviderDeliveryTypes, assetProviderSupportsReferenceImage } from "./provider-catalog.js";
import { buildStudioChildEnvironment } from "./studio-child-environment.js";

const execFileAsync = promisify(execFile);
const GENERATED_MEDIA_PROBE_TIMEOUT_MS = 30_000;

type GeneratedMediaProbeRunner = (
  command: string,
  args: string[],
  options: { maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

const runGeneratedMediaProbe: GeneratedMediaProbeRunner = async (command, args, options) => {
  const { stdout } = await execFileAsync(command, args, options);
  return { stdout: String(stdout) };
};

export interface ProductionWorkerOptions {
  repositoryRoot: string;
  pythonPath: string;
  environment: NodeJS.ProcessEnv;
  runsRoot?: string;
  visualReviewAgents?: VisualReviewAgent[];
}

export function buildProductionWorker(options: ProductionWorkerOptions): GenerativeAssetWorkerClient {
  const fallback = new PythonWorkerClient({
    command: [resolveProductionPython(options.repositoryRoot, options.environment), "-m", "video_factory.worker"],
    cwd: options.repositoryRoot,
    env: buildStudioChildEnvironment(options.environment, { PYTHONPATH: options.pythonPath }),
    timeoutMs: 20 * 60 * 1000,
  });
  const adapters: VideoGenerationAdapterBinding[] = readMeteredVideoProviderSettings(options.environment).map((setting) => {
    const adapter = setting.providerId === "seedance-video-v1"
      ? new SeedanceVideoAdapter({
          apiKey: setting.apiKey,
          model: setting.model,
          allowedModels: setting.models.map((model) => model.id),
          ...(setting.baseUrl ? { baseUrl: setting.baseUrl } : {}),
        })
      : setting.providerId === "hailuo-video-v1"
        ? new MiniMaxVideoAdapter({
            apiKey: setting.apiKey,
            model: setting.model,
            modelProtocols: Object.fromEntries(setting.models.map((model) => [model.id, model.protocol ?? "v1"])),
            ...(setting.baseUrl ? { baseUrl: setting.baseUrl } : {}),
          })
        : new WanVideoAdapter({
          apiKey: setting.apiKey,
          model: setting.model,
          allowedModels: setting.models.map((model) => model.id),
          workspaceId: setting.workspaceId,
          ...(setting.baseUrl ? { baseUrl: setting.baseUrl } : {}),
        });
    return {
      adapter,
      estimatedCnyPerClip: setting.estimatedCnyPerClip,
      defaultModelId: setting.model,
      modelPrices: Object.fromEntries(setting.models.map((model) => [model.id, model.estimatedCnyPerClip])),
      modelProfiles: Object.fromEntries(setting.models.map((model) => [model.id, {
        taskTypes: [...model.taskTypes],
        resolutions: [...model.resolutions],
        aspectRatios: [...model.aspectRatios],
        minDurationSeconds: model.minDurationSeconds,
        maxDurationSeconds: model.maxDurationSeconds,
        supportsAudio: model.supportsAudio,
        ...(model.allowedDurationsSeconds
          ? { allowedDurationsSeconds: [...model.allowedDurationsSeconds] }
          : {}),
        ...(model.estimatedCnyPerSecond ? { estimatedCnyPerSecond: model.estimatedCnyPerSecond } : {}),
        ...(model.estimatedCnyPerSecondByResolution
          ? { estimatedCnyPerSecondByResolution: { ...model.estimatedCnyPerSecondByResolution } }
          : {}),
        ...(model.estimatedCnyByResolutionAndDuration
          ? { estimatedCnyByResolutionAndDuration: structuredClone(model.estimatedCnyByResolutionAndDuration) }
          : {}),
      }])),
    };
  });
  const imageAdapters: ImageGenerationAdapterBinding[] = readMeteredImageProviderSettings(options.environment).map((setting) => ({
    adapter: new SeedreamImageAdapter({
      apiKey: setting.apiKey,
      model: setting.model,
      ...(setting.baseUrl ? { baseUrl: setting.baseUrl } : {}),
    }),
    estimatedCnyPerImage: setting.estimatedCnyPerImage,
  }));
  return new GenerativeAssetWorkerClient({
    fallback,
    adapters,
    imageAdapters,
    probeGeneratedMedia: probeGeneratedMediaWithFfprobe,
    pilotReviewer: new SourceAssetPilotReviewer(options.visualReviewAgents ?? []),
    ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
  });
}

export async function probeGeneratedMediaWithFfprobe(
  mediaPath: string,
  mediaType: "image" | "video",
  runner: GeneratedMediaProbeRunner = runGeneratedMediaProbe,
): Promise<GeneratedMediaMetadata> {
  const { stdout } = await runner("ffprobe", [
    "-v", "error",
    // Provider 媒体是不可信输入；只允许读取已下载的本地文件，禁止播放列表或容器再访问网络。
    "-protocol_whitelist", "file,pipe",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    mediaPath,
  ], { maxBuffer: 1024 * 1024, timeout: GENERATED_MEDIA_PROBE_TIMEOUT_MS });
  const result = JSON.parse(stdout) as {
    streams?: Array<{ width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const stream = result.streams?.[0];
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  const durationSeconds = Number(result.format?.duration);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`ffprobe did not return valid dimensions for generated ${mediaType}.`);
  }
  return {
    width,
    height,
    ...(mediaType === "video" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds }
      : {}),
  };
}

export function buildDirectorAssetProviders(options: Pick<ProductionWorkerOptions, "environment">): VisualAssetProviderCapability[] {
  const providers: VisualAssetProviderCapability[] = [
    {
      id: "local-editorial-v1",
      label: "本地编辑卡片",
      billing: "free",
      modes: ["本地排版"],
      deliveryTypes: assetProviderDeliveryTypes("local-editorial-v1"),
      strengths: ["标题卡、数据卡、清单步骤、引语、转场与片尾行动提示"],
      constraints: [
        "只交付一张静态卡片，所有元素从首帧就存在，渲染器最多做整张画面的轻微推拉",
        "不支持逐字、逐项、箭头、图形或物件动画",
        "不绘制定制插画或物理示意动画",
        "不包含真实人物动作或现场环境",
        "不能假设存在用户尚未上传的自有图片",
      ],
    },
  ];
  if (options.environment.PEXELS_API_KEY) {
    providers.push({
      id: "pexels-stock-v1",
      label: "Pexels 视频",
      billing: "free",
      modes: ["实拍", "竖屏搜索"],
      deliveryTypes: assetProviderDeliveryTypes("pexels-stock-v1"),
      strengths: ["通用真实人物、生活动作、办公场景、城市与自然环境、建立镜头"],
      constraints: ["通用图库不是具体新闻事件证据", "不得把图库人物描述为事件当事人", "中文地域与具体事件匹配度可能有限"],
    });
  }
  if (options.environment.PIXABAY_API_KEY) {
    providers.push({
      id: "pixabay-stock-v1",
      label: "Pixabay 视频",
      billing: "free",
      modes: ["实拍", "安全搜索"],
      deliveryTypes: assetProviderDeliveryTypes("pixabay-stock-v1"),
      strengths: ["通用环境、物件、抽象概念与补充实拍镜头"],
      constraints: ["通用图库不是具体新闻事件证据", "不得把图库人物描述为事件当事人", "中文语义搜索结果可能需要人工复核"],
    });
  }
  if (options.environment.UNSPLASH_ACCESS_KEY?.trim()) {
    providers.push({
      id: "unsplash-stock-v1",
      label: "Unsplash 图片",
      billing: "free",
      modes: ["摄影图片", "作者署名"],
      deliveryTypes: assetProviderDeliveryTypes("unsplash-stock-v1"),
      strengths: ["通用生活、建筑、自然与物件摄影，补充静态画面"],
      constraints: ["只交付图片，不交付视频或动作", "不是具体新闻事件证据", "需保留作者署名，人物和商标权仍需核对"],
    });
  }
  if (options.environment.FLICKR_API_KEY?.trim()) {
    providers.push({
      id: "flickr-stock-v1", label: "Flickr 开放摄影图片", billing: "free",
      modes: ["摄影图片", "逐文件许可"], deliveryTypes: assetProviderDeliveryTypes("flickr-stock-v1"),
      strengths: ["公开城市、自然和生活摄影，补充静态画面"],
      constraints: ["仅图片，不提供视频或动作", "采用前复核下载权限和许可；须保留署名并遵守非商业等条件", "不是特定新闻事件的保证证据"],
    });
  }
  if (options.environment.COVERR_API_KEY?.trim()) {
    providers.push({
      id: "coverr-stock-v1",
      label: "Coverr 视频",
      billing: "free",
      modes: ["实拍", "横竖屏候选", "HD/4K"],
      deliveryTypes: assetProviderDeliveryTypes("coverr-stock-v1"),
      strengths: ["通用生活、人物、城市、自然和创意实拍镜头，补充 Pexels 与 Pixabay 的覆盖"],
      constraints: ["通用图库不是具体新闻事件证据", "不得把图库人物描述为事件当事人", "使用 API 时需展示 Coverr 来源"],
    });
  }
  providers.push({
    id: "wikimedia-stock-v1",
    label: "Wikimedia 图片与视频",
    billing: "free",
    modes: ["图片与视频", "逐文件许可"],
    deliveryTypes: assetProviderDeliveryTypes("wikimedia-stock-v1"),
    strengths: ["补充全球城市、自然、历史与知识类公开视频，无需 API Key"],
    constraints: ["不是特定新闻事件的保证证据，须逐文件核验", "至少 720p；图片不超过 64MB/8000万像素，视频不超过 128MB；大图按实际输出缩放", "保留作者与许可；CC BY-SA 改编须同许可分享，发布前确认能履行"],
  });
  for (const source of [
    { id: "archive-stock-v1", label: "Internet Archive 开放视频", strengths: ["开放素材集合的自然、城市、延时摄影实拍片段，无需 Key"], constraints: ["只检索 stock_footage 中逐项明确开放许可的片段，不代表全站版权担保", "至少 720p、单文件不超过 128MB；保留署名，非商业及同许可分享条件须遵守", "不是具体新闻事件的保证证据，原片声音不代表可独立使用的音乐授权"] },
    { id: "cleveland-stock-v1", label: "Cleveland 开放馆藏图片", strengths: ["中国与世界绘画、文物、玉器、陶瓷的 CC0 高清图片"], constraints: ["仅图片；不是现代生活或特定新闻事件证据", "仅使用逐条明确 CC0 的高清 JPEG，保留年代、机构与来源"] },
    { id: "met-stock-v1", label: "Met 开放馆藏图片", strengths: ["历史文物、绘画、器物和服饰开放图像；包含中国馆藏"], constraints: ["只提供图片，不提供现代生活视频", "核对作品年代与描述，不能把图片当特定事件证据"] },
    { id: "nasa-stock-v1", label: "NASA 科学图片与视频", strengths: ["科学、航天、地球观测图片和视频"], constraints: ["按题材选择，不适合普通生活 B-roll", "核对第三方权利与真实尺寸，保留机构和创作者，不暗示官方背书"] },
    { id: "openverse-stock-v1", label: "Openverse 开放图片", strengths: ["开放许可图片聚合，补充城市、自然与文化摄影"], constraints: ["不提供视频；会与其他来源重复", "原站文件和许可须核对；非商业素材须满足非商业用途，不能一概当商业可用"] },
  ]) {
    providers.push({ ...source, billing: "free", modes: ["无需 Key", "来源与许可"], deliveryTypes: assetProviderDeliveryTypes(source.id) });
  }
  for (const setting of readMeteredImageProviderSettings(options.environment)) {
    providers.push({
      id: setting.providerId,
      label: "Seedream 关键画面",
      billing: "metered",
      modes: [
        "AI 图片",
        ...(assetProviderSupportsReferenceImage(setting.providerId, setting.model) ? ["参考图再生成"] : []),
        "9:16",
      ],
      deliveryTypes: assetProviderDeliveryTypes(setting.providerId),
      supportsReferenceImage: assetProviderSupportsReferenceImage(setting.providerId, setting.model),
      strengths: ["解释性插画、抽象概念、无法检索到的关键静态画面与统一系列视觉"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: setting.estimatedCnyPerImage,
      generative: true,
    });
  }
  for (const setting of readMeteredVideoProviderSettings(options.environment)) {
    providers.push({
      id: setting.providerId,
      label: setting.providerId === "seedance-video-v1"
        ? "Seedance 关键镜头"
        : setting.providerId === "hailuo-video-v1" ? "MiniMax 视频生成" : "百炼 · 通义万相视频",
      billing: "metered",
      modes: ["AI 视频", "9:16"],
      deliveryTypes: assetProviderDeliveryTypes(setting.providerId),
      strengths: ["难以实拍的概念视觉、情绪化转场与关键表现镜头"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: setting.estimatedCnyPerClip,
      generative: true,
    });
  }
  return providers;
}

export function buildProductionProviderRuntimeMetadata(environment: NodeJS.ProcessEnv): ProductionProviderRuntimeMetadata[] {
  const deepseekVisualModelId = resolveDeepseekModelId(environment);
  const metadata: ProductionProviderRuntimeMetadata[] = [
    { id: "python-template-v1", label: "模板脚本", modelId: "rules-v1", transport: "local_process", billing: "free" },
    { id: "ai-shot-router-v1", label: "AI 逐镜路由", modelId: "router-v1", transport: "local_process", billing: "free" },
    { id: "local-editorial-v1", label: "本地编辑卡片", modelId: "editorial-v1", transport: "local_process", billing: "free" },
    { id: "pexels-stock-v1", label: "Pexels 视频", modelId: "pexels-api", transport: "http_api", billing: "free" },
    { id: "pixabay-stock-v1", label: "Pixabay 视频", modelId: "pixabay-api", transport: "http_api", billing: "free" },
    { id: "unsplash-stock-v1", label: "Unsplash 图片", modelId: "unsplash-api", transport: "http_api", billing: "free" },
    { id: "coverr-stock-v1", label: "Coverr 视频", modelId: "coverr-api", transport: "http_api", billing: "free" },
    { id: "wikimedia-stock-v1", label: "Wikimedia 图片与视频", modelId: "wikimedia-api", transport: "http_api", billing: "free" },
    { id: "met-stock-v1", label: "Met 开放馆藏图片", modelId: "met-api", transport: "http_api", billing: "free" },
    { id: "cleveland-stock-v1", label: "Cleveland 开放馆藏图片", modelId: "cleveland-api", transport: "http_api", billing: "free" },
    { id: "archive-stock-v1", label: "Internet Archive 开放视频", modelId: "archive-api", transport: "http_api", billing: "free" },
    { id: "flickr-stock-v1", label: "Flickr 开放摄影图片", modelId: "flickr-api", transport: "http_api", billing: "free" },
    { id: "nasa-stock-v1", label: "NASA 科学图片与视频", modelId: "nasa-api", transport: "http_api", billing: "free" },
    { id: "openverse-stock-v1", label: "Openverse 开放图片", modelId: "openverse-api", transport: "http_api", billing: "free" },
    { id: "macos-say-v1", label: "macOS 系统配音", modelId: "say", transport: "local_process", billing: "free" },
    { id: "kokoro-local-v1", label: "Kokoro 本地配音", modelId: "kokoro", transport: "local_process", billing: "local_compute" },
    { id: "python-ffmpeg-v1", label: "FFmpeg 竖屏渲染", modelId: "ffmpeg", transport: "local_process", billing: "local_compute" },
    { id: "python-technical-review-v1", label: "本地机器质检", modelId: "ffprobe", transport: "local_process", billing: "local_compute" },
    {
      id: "deepseek-visual-review-v1",
      label: `DeepSeek ${deepseekVisualModelId} 视觉审片`,
      modelId: deepseekVisualModelId,
      transport: "unix_socket",
      billing: "subscription",
      approvalPolicy: "none",
      maxAttempts: 3,
    },
  ];
  for (const setting of readMeteredImageProviderSettings(environment)) metadata.push({
    id: setting.providerId,
    label: "Seedream 关键画面",
    modelId: setting.model,
    transport: "http_api",
    billing: "metered",
    estimatedCostCny: setting.estimatedCnyPerImage,
    maxAttempts: 1,
  });
  for (const setting of readMeteredVideoProviderSettings(environment)) metadata.push({
    id: setting.providerId,
    label: setting.providerId === "seedance-video-v1" ? "Seedance 关键镜头" : setting.providerId === "hailuo-video-v1" ? "MiniMax 视频生成" : "百炼 · 通义万相视频",
    modelId: setting.model,
    transport: "http_api",
    billing: "metered",
    estimatedCostCny: setting.estimatedCnyPerClip,
    maxAttempts: 1,
    modelProfiles: setting.models.map((model) => ({
      modelId: model.id,
      estimatedCostCny: model.estimatedCnyPerClip,
      taskTypes: [...model.taskTypes],
      resolutions: [...model.resolutions],
      aspectRatios: [...model.aspectRatios],
      minDurationSeconds: model.minDurationSeconds,
      maxDurationSeconds: model.maxDurationSeconds,
      supportsAudio: model.supportsAudio,
      ...(model.allowedDurationsSeconds
        ? { allowedDurationsSeconds: [...model.allowedDurationsSeconds] }
        : {}),
      ...(model.estimatedCnyPerSecond ? { estimatedCnyPerSecond: model.estimatedCnyPerSecond } : {}),
      ...(model.estimatedCnyPerSecondByResolution
        ? { estimatedCnyPerSecondByResolution: { ...model.estimatedCnyPerSecondByResolution } }
        : {}),
      ...(model.estimatedCnyByResolutionAndDuration
        ? { estimatedCnyByResolutionAndDuration: structuredClone(model.estimatedCnyByResolutionAndDuration) }
        : {}),
    })),
  });
  if (environment.MINIMAX_API_KEY) metadata.push({
    id: "minimax-tts-v1",
    label: "MiniMax 中文声音演员",
    modelId: environment.MINIMAX_TTS_MODEL_ID?.trim() || "speech-2.8-turbo",
    transport: "http_api",
    billing: "metered",
    approvalPolicy: "automatic",
    billingUnit: "run",
    estimatedCostCny: positiveEstimate(environment.MINIMAX_TTS_ESTIMATED_CNY_PER_CLIP, 0.5),
    maxAttempts: 1,
  });
  return metadata;
}

function positiveEstimate(value: string | undefined, fallback: number): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveProductionPython(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  pathExists: (target: string) => boolean = existsSync,
): string {
  if (environment.VIDEO_FACTORY_PYTHON) return environment.VIDEO_FACTORY_PYTHON;
  const localRuntime = path.join(repositoryRoot, ".local", "python", ".venv", "bin", "python");
  return pathExists(localRuntime) ? localRuntime : "python3";
}
