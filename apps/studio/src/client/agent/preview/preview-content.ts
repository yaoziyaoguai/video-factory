import trailOne from "./assets/trail-1.png";
import trailTwo from "./assets/trail-2.png";
import coffeeHome from "./assets/coffee-home.png";
import coffeeDetail from "./assets/coffee-detail.png";
import coffeeOffice from "./assets/coffee-office.png";

// 预览素材目录：只保留内存 Mock 后端引用的图片与元数据（审计第三阶段合并重复原型后，
// 原型专用的模型目录/技能清单已由 mock-backend 的契约形状取代）。视频与音频字节由
// vite.config.ts 的预览中间件按固定 blobId 从 assets 目录提供，不经打包 URL。

export interface SampleCandidate {
  id: string;
  name: string;
  kind: "video" | "image";
  image: string;
  duration: string;
}
export const sampleImages = { trailOne, trailTwo, coffeeHome, coffeeDetail, coffeeOffice };
export const candidates: SampleCandidate[] = [
  {
    id: "ridge",
    name: "沿山径出发",
    kind: "video",
    image: trailOne,
    duration: "选用 6 秒",
  },
  {
    id: "forest",
    name: "走进树林",
    kind: "video",
    image: trailTwo,
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
    duration: "选用 6 秒",
  },
  {
    id: "detail",
    name: "水流与杯口",
    kind: "video",
    image: coffeeDetail,
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
