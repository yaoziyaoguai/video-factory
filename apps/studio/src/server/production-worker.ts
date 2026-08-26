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
  type VideoGenerationAdapterBinding,
} from "@video-factory/production-pipeline";
import { readMeteredVideoProviderSettings } from "./video-provider-settings.js";
import { readMeteredImageProviderSettings } from "./image-provider-settings.js";

export interface ProductionWorkerOptions {
  repositoryRoot: string;
  pythonPath: string;
  environment: NodeJS.ProcessEnv;
}

export function buildProductionWorker(options: ProductionWorkerOptions): GenerativeAssetWorkerClient {
  const fallback = new PythonWorkerClient({
    command: [resolveProductionPython(options.repositoryRoot, options.environment), "-m", "video_factory.worker"],
    cwd: options.repositoryRoot,
    env: { ...options.environment, PYTHONPATH: options.pythonPath },
    timeoutMs: 20 * 60 * 1000,
  });
  const adapters: VideoGenerationAdapterBinding[] = readMeteredVideoProviderSettings(options.environment).map((setting) => {
    const adapter = setting.providerId === "seedance-video-v1"
      ? new SeedanceVideoAdapter({
          apiKey: setting.apiKey,
          model: setting.model,
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
    return { adapter, estimatedCnyPerClip: setting.estimatedCnyPerClip };
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
      modes: ["本地", "自有素材"],
      strengths: ["标题卡、数据卡、清单步骤、引语、转场、片尾行动提示与自有静态图片"],
      constraints: ["不包含真实人物动作或现场环境", "不能充当新闻事件、人物表情或具体地点的视觉证据"],
    },
  ];
  if (options.environment.PEXELS_API_KEY) {
    providers.push({
      id: "pexels-stock-v1",
      label: "Pexels 视频",
      billing: "free",
      modes: ["实拍", "竖屏搜索"],
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
      strengths: ["难以实拍的概念视觉、情绪化转场与关键表现镜头"],
      constraints: ["合成内容不得作为事实证据", "人物、品牌与地标需要规避权利和误导风险", "成片必须保留 AIGC 标识"],
      estimatedCnyPerClip: setting.estimatedCnyPerClip,
      generative: true,
    });
  }
  return providers;
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
