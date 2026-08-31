import { existsSync } from "node:fs";
import path from "node:path";
import {
  GenerativeAssetWorkerClient,
  MiniMaxVideoAdapter,
  PythonWorkerClient,
  SeedreamImageAdapter,
  SeedanceVideoAdapter,
  WanVideoAdapter,
  type VisualAssetProviderCapability,
  type ImageGenerationAdapterBinding,
  type ProductionProviderRuntimeMetadata,
  type VideoGenerationAdapterBinding,
} from "@video-factory/production-pipeline";
import { readMeteredVideoProviderSettings } from "./video-provider-settings.js";
import { readMeteredImageProviderSettings } from "./image-provider-settings.js";
import { resolveZaiVisualReviewModelId } from "./codex-provider-settings.js";
import { buildStudioChildEnvironment } from "./studio-child-environment.js";

export interface ProductionWorkerOptions {
  repositoryRoot: string;
  pythonPath: string;
  environment: NodeJS.ProcessEnv;
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
            ...(setting.baseUrl ? { baseUrl: setting.baseUrl } : {}),
          })
        : new WanVideoAdapter({
          apiKey: setting.apiKey,
          model: setting.model,
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
        minDurationSeconds: model.minDurationSeconds,
        maxDurationSeconds: model.maxDurationSeconds,
        supportsAudio: model.supportsAudio,
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
  return new GenerativeAssetWorkerClient({ fallback, adapters, imageAdapters });
}

export function buildDirectorAssetProviders(options: Pick<ProductionWorkerOptions, "environment">): VisualAssetProviderCapability[] {
  const providers: VisualAssetProviderCapability[] = [
    {
      id: "local-editorial-v1",
      label: "本地编辑卡片",
      billing: "free",
      modes: ["本地排版"],
      deliveryTypes: ["editorial_card"],
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
      deliveryTypes: ["stock_video", "stock_image"],
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
      deliveryTypes: ["stock_video", "stock_image"],
      strengths: ["通用环境、物件、抽象概念与补充实拍镜头"],
      constraints: ["通用图库不是具体新闻事件证据", "不得把图库人物描述为事件当事人", "中文语义搜索结果可能需要人工复核"],
    });
  }
  for (const setting of readMeteredImageProviderSettings(options.environment)) {
    providers.push({
      id: setting.providerId,
      label: "Seedream 关键画面",
      billing: "metered",
      modes: ["AI 图片", "9:16"],
      deliveryTypes: ["generated_image"],
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
        : setting.providerId === "hailuo-video-v1" ? "MiniMax 海螺关键镜头" : "Wan 关键镜头",
      billing: "metered",
      modes: ["AI 视频", "9:16"],
      deliveryTypes: ["generated_video"],
      strengths: ["难以实拍的概念视觉、情绪化转场与关键表现镜头"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: setting.estimatedCnyPerClip,
      generative: true,
    });
  }
  return providers;
}

export function buildProductionProviderRuntimeMetadata(environment: NodeJS.ProcessEnv): ProductionProviderRuntimeMetadata[] {
  const zaiVisualReviewModelId = resolveZaiVisualReviewModelId(environment);
  const metadata: ProductionProviderRuntimeMetadata[] = [
    { id: "python-template-v1", label: "模板脚本", modelId: "rules-v1", transport: "local_process", billing: "free" },
    { id: "ai-shot-router-v1", label: "AI 逐镜路由", modelId: "router-v1", transport: "local_process", billing: "free" },
    { id: "local-editorial-v1", label: "本地编辑卡片", modelId: "editorial-v1", transport: "local_process", billing: "free" },
    { id: "pexels-stock-v1", label: "Pexels 视频", modelId: "pexels-api", transport: "http_api", billing: "free" },
    { id: "pixabay-stock-v1", label: "Pixabay 视频", modelId: "pixabay-api", transport: "http_api", billing: "free" },
    { id: "macos-say-v1", label: "macOS 系统配音", modelId: "say", transport: "local_process", billing: "free" },
    { id: "kokoro-local-v1", label: "Kokoro 本地配音", modelId: "kokoro", transport: "local_process", billing: "local_compute" },
    { id: "python-ffmpeg-v1", label: "FFmpeg 竖屏渲染", modelId: "ffmpeg", transport: "local_process", billing: "local_compute" },
    { id: "python-technical-review-v1", label: "本地机器质检", modelId: "ffprobe", transport: "local_process", billing: "local_compute" },
    {
      id: "glm-visual-review-v1",
      label: `${zaiVisualReviewModelId === "glm-5.3-flash" ? "GLM-5.3-Flash" : zaiVisualReviewModelId} 视觉审片`,
      modelId: zaiVisualReviewModelId,
      transport: "unix_socket",
      billing: "metered",
      billingUnit: "run",
      estimatedCostCny: positiveEstimate(environment.ZAI_VISUAL_REVIEW_ESTIMATED_CNY, 0.1),
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
    label: setting.providerId === "seedance-video-v1" ? "Seedance 关键镜头" : setting.providerId === "hailuo-video-v1" ? "MiniMax 海螺关键镜头" : "Wan 关键镜头",
    modelId: setting.model,
    transport: "http_api",
    billing: "metered",
    estimatedCostCny: setting.estimatedCnyPerClip,
    maxAttempts: 1,
    modelProfiles: setting.models.map((model) => ({
      modelId: model.id,
      estimatedCostCny: model.estimatedCnyPerClip,
    })),
  });
  if (environment.MINIMAX_API_KEY) metadata.push({
    id: "minimax-tts-v1",
    label: "MiniMax 中文声音演员",
    modelId: environment.MINIMAX_TTS_MODEL_ID?.trim() || "speech-2.8-turbo",
    transport: "http_api",
    billing: "metered",
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
