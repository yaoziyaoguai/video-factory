export type StudioDirectorProfileId =
  | "auto"
  | "documentary-observer"
  | "quiet-humanism"
  | "urban-poetic"
  | "chromatic-storytelling"
  | "geometric-control"
  | "suspense-staging";

export interface StudioDirectorProfile {
  id: StudioDirectorProfileId;
  label: string;
  inspiration: string;
  summary: string;
  bestFor: string;
}

export const STUDIO_DIRECTOR_PROFILES: readonly StudioDirectorProfile[] = [
  {
    id: "auto",
    label: "自动选导演",
    inspiration: "AI 总导演",
    summary: "AI 根据题材选择导演语法，再逐镜决定素材来源。",
    bestFor: "第一次制作、题材未定型",
  },
  {
    id: "documentary-observer",
    label: "纪实观察",
    inspiration: "贾樟柯与当代纪录传统",
    summary: "真实地点、环境声和克制镜头，事实优先。",
    bestFor: "热点解释、地方文化、人物观察",
  },
  {
    id: "quiet-humanism",
    label: "静观生活",
    inspiration: "小津安二郎与侯孝贤的生活观察",
    summary: "固定机位、自然光和留白，让日常动作自己说话。",
    bestFor: "生活方式、家庭、情绪内容",
  },
  {
    id: "urban-poetic",
    label: "都市诗意",
    inspiration: "王家卫式都市情绪传统",
    summary: "偏置构图、夜色和碎片化节奏，强调人物感受。",
    bestFor: "都市情绪、音乐、时尚与关系",
  },
  {
    id: "chromatic-storytelling",
    label: "色彩叙事",
    inspiration: "张艺谋式色彩与空间调度传统",
    summary: "大色块、群体几何和宽景特写反差。",
    bestFor: "文化、美食、节庆与视觉奇观",
  },
  {
    id: "geometric-control",
    label: "几何秩序",
    inspiration: "库布里克式中心构图传统",
    summary: "对称、透视和缓慢运动，建立理性控制感。",
    bestFor: "科技、产品、建筑与冷静解释",
  },
  {
    id: "suspense-staging",
    label: "悬念调度",
    inspiration: "希区柯克式视点与信息差传统",
    summary: "主观视角、物件特写和反应镜头制造信息差。",
    bestFor: "悬疑解释、避坑、反转与故事内容",
  },
] as const;
