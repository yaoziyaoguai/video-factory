import trailOne from "./assets/trail-1.png";
import trailTwo from "./assets/trail-2.png";
import coffeeHome from "./assets/coffee-home.png";
import coffeeDetail from "./assets/coffee-detail.png";
import coffeeOffice from "./assets/coffee-office.png";
import trailSource from "./assets/trail-demo.mp4";
import coffeeSource from "./assets/coffee-home-demo.mp4";
import trailVoice from "./assets/narration.mp3";
import coffeeVoice from "./assets/coffee-narration.mp3";
import trailOutput from "./assets/trail-preview.mp4";
import trailSilent from "./assets/trail-preview-silent.mp4";
import coffeeOutput from "./assets/coffee-preview.mp4";
import coffeeSilent from "./assets/coffee-preview-silent.mp4";

export interface SampleCandidate {
  id: string;
  name: string;
  kind: "video" | "image";
  image: string;
  video?: string;
  duration: string;
}
export const sampleFiles = {
  trailOne,
  trailTwo,
  coffeeHome,
  coffeeDetail,
  coffeeOffice,
  trailSource,
  coffeeSource,
  trailVoice,
  coffeeVoice,
  trailOutput,
  trailSilent,
  coffeeOutput,
  coffeeSilent,
};
export const candidates: SampleCandidate[] = [
  {
    id: "ridge",
    name: "沿山径出发",
    kind: "video",
    image: trailOne,
    video: trailSource,
    duration: "选用 6 秒",
  },
  {
    id: "forest",
    name: "走进树林",
    kind: "video",
    image: trailTwo,
    video: trailSource,
    duration: "选用 6 秒",
  },
  {
    id: "rest",
    name: "把风景多留一会儿",
    kind: "image",
    image: trailTwo,
    duration: "停留 8 秒",
  },
  {
    id: "kitchen",
    name: "清晨的厨房",
    kind: "video",
    image: coffeeHome,
    video: coffeeSource,
    duration: "选用 6 秒",
  },
  {
    id: "detail",
    name: "水流与杯口",
    kind: "video",
    image: coffeeDetail,
    video: coffeeSource,
    duration: "选用 6 秒",
  },
  {
    id: "office",
    name: "给今天留白",
    kind: "image",
    image: coffeeOffice,
    duration: "停留 8 秒",
  },
];
export const sampleVoice = trailVoice;
export const sampleVideo = trailOutput;

export type ModelKind = "text" | "image" | "video" | "speech";
export interface SampleModel {
  id: string;
  name: string;
  modelId: string;
  provider: string;
  description: string;
  supported: boolean;
}
export const modelKinds: { id: ModelKind; name: string }[] = [
  { id: "text", name: "文本大模型" },
  { id: "image", name: "图片模型" },
  { id: "video", name: "视频模型" },
  { id: "speech", name: "配音模型" },
];
// 固定交互示例，不代表厂商当前目录或可用性；不读取日常实例的账号或 Key。
export const modelDirectory: Record<ModelKind, SampleModel[]> = {
  text: [
    {
      id: "qwen",
      name: "通义千问 Plus",
      modelId: "qwen-plus",
      provider: "阿里云百炼",
      description: "日常对话、内容创作与工具协作",
      supported: true,
    },
    {
      id: "qwen-max",
      name: "通义千问 Max",
      modelId: "qwen-max",
      provider: "阿里云百炼",
      description: "复杂内容梳理与创作协作",
      supported: true,
    },
    {
      id: "deepseek",
      name: "DeepSeek V4 Flash",
      modelId: "deepseek-v4-flash",
      provider: "DeepSeek",
      description: "复杂推理、脚本梳理与长内容讨论",
      supported: true,
    },
    {
      id: "deepseek-pro",
      name: "DeepSeek V4 Pro",
      modelId: "deepseek-v4-pro",
      provider: "DeepSeek",
      description: "复杂推理与长内容讨论",
      supported: true,
    },
    {
      id: "sonnet",
      name: "Claude Sonnet 4.5",
      modelId: "claude-sonnet-4-5",
      provider: "Anthropic",
      description: "长文理解、表达与创作协作",
      supported: true,
    },
  ],
  image: [
    {
      id: "seedream",
      name: "Seedream 4.0",
      modelId: "doubao-seedream-4-0-250828",
      provider: "火山方舟",
      description: "画面构思、分镜示意与图像生成",
      supported: true,
    },
    {
      id: "seedream-3",
      name: "Seedream 3.0",
      modelId: "doubao-seedream-3-0-t2i-250415",
      provider: "火山方舟",
      description: "文字生成图片",
      supported: true,
    },
    {
      id: "wan-image",
      name: "通义万相 2.1 文生图",
      modelId: "wan2.1-t2i-turbo",
      provider: "阿里云百炼",
      description: "图像生成；此演示选项尚未接入执行",
      supported: false,
    },
  ],
  video: [
    {
      id: "seedance",
      name: "Seedance 2.5",
      modelId: "doubao-seedance-2-5-260628",
      provider: "火山方舟",
      description: "按已确认方案生成视频片段",
      supported: true,
    },
    {
      id: "seedance-lite",
      name: "Seedance 1.0 Lite",
      modelId: "doubao-seedance-1-0-lite-t2v-250428",
      provider: "火山方舟",
      description: "按文字方案生成视频片段",
      supported: true,
    },
    {
      id: "wan-video",
      name: "通义万相 2.1 文生视频",
      modelId: "wan2.1-t2v-turbo",
      provider: "阿里云百炼",
      description: "目录候选；尚未接入此演示的执行范围",
      supported: false,
    },
  ],
  speech: [
    {
      id: "minimax",
      name: "MiniMax Speech 2.8 Turbo",
      modelId: "speech-2.8-turbo",
      provider: "MiniMax",
      description: "为已确认的旁白生成声音",
      supported: true,
    },
    {
      id: "minimax-hd",
      name: "MiniMax Speech 2.8 HD",
      modelId: "speech-2.8-hd",
      provider: "MiniMax",
      description: "为已确认的旁白生成声音",
      supported: true,
    },
    {
      id: "qwen-voice",
      name: "通义千问 TTS",
      modelId: "qwen-tts",
      provider: "阿里云百炼",
      description: "目录候选；尚未接入此演示的执行范围",
      supported: false,
    },
  ],
};
export interface SampleSkill {
  id: string;
  name: string;
  description: string;
  source: string;
  builtin: boolean;
}
export const initialSkills: SampleSkill[] = [
  {
    id: "story",
    name: "旅行叙事",
    description: "从感受出发，梳理短片的叙事与镜头。",
    source: "内置示例",
    builtin: true,
  },
];
