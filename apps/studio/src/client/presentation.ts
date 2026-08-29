export const RUN_NODE_LABELS: Record<string, string> = {
  brief: "内容简报",
  script: "脚本",
  "reference-grammar": "参考镜头语法",
  "visual-direction": "导演方案",
  "asset-candidates": "候选素材",
  "asset-semantic-rank": "语义选片",
  assets: "画面",
  voice: "配音",
  render: "渲染",
  "technical-review": "机器质检",
  "visual-review": "视觉审片",
  "final-review": "人工终审",
  "publish-package": "发布文案与发布包",
};

export const RUN_NODE_ORDER = Object.keys(RUN_NODE_LABELS);

export function runNodeLabel(nodeId: string): string {
  return RUN_NODE_LABELS[nodeId] ?? nodeId;
}

export function platformLabel(platform: string): string {
  return ({
    douyin: "抖音",
    kuaishou: "快手",
    xiaohongshu: "小红书",
    shipinhao: "视频号",
    bilibili: "哔哩哔哩",
    weibo: "微博",
    zhihu: "知乎",
    baidu: "百度",
    toutiao: "今日头条",
    thepaper: "澎湃新闻",
    "36kr": "36氪",
    ithome: "IT之家",
    sspai: "少数派",
    hupu: "虎扑",
    tieba: "百度贴吧",
    guokr: "果壳",
  } as Record<string, string>)[platform] ?? platform;
}

export function providerLabel(providerId?: string): string | undefined {
  if (!providerId) return undefined;
  return ({
    "inline:brief": "VideoFactory 制片",
    "inline:final-review": "人工终审",
    "inline:publish-package": "本地发布编排",
    "video-factory-ts-v1": "VideoFactory 本地编排",
    "python-template-v1": "本地模板脚本",
    "codex-screenwriter-v1": "Codex 编剧",
    "api-visual-director-v1": "Codex 视觉导演",
    "codex-reference-grammar-v1": "Codex 参考视频分析",
    "codex-asset-ranker-v1": "Codex 语义选片",
    "codex-publish-copy-v1": "Codex 发行编辑",
    "ai-shot-router-v1": "AI 逐镜路由",
    "local-editorial-v1": "本地编辑画面",
    "pexels-stock-v1": "Pexels 图库",
    "pixabay-stock-v1": "Pixabay 图库",
    "seedream-image-v1": "Seedream 图片生成",
    "seedance-video-v1": "Seedance 视频生成",
    "hailuo-video-v1": "MiniMax 海螺视频生成",
    "wan-video-v1": "通义万相视频生成",
    "macos-say-v1": "macOS 系统配音",
    "python-ffmpeg-v1": "FFmpeg 本地渲染",
    "python-technical-review-v1": "本地机器质检",
    "codex-visual-review-v1": "Codex 视觉审片",
    "glm-visual-review-v1": "GLM-5.3-Flash 视觉审片",
    pexels: "Pexels 图库",
    pixabay: "Pixabay 图库",
    local: "本地编辑画面",
    minimax: "MiniMax",
    seedance: "Seedance",
  } as Record<string, string>)[providerId] ?? providerId;
}

export function humanizeCreativeText(value: string): string {
  return value
    .replace(/^question\s*\/\s*shot-question\s*[：:]?\s*/i, "提问钩子：")
    .replace(/^model\s*\/\s*shot-model\s*[：:]?\s*/i, "原理说明：")
    .replace(/^example\s*\/\s*shot-example\s*[：:]?\s*/i, "实例验证：")
    .replace(/^takeaway\s*\/\s*shot-takeaway\s*[：:]?\s*/i, "结论行动：")
    .replace(/question[—-]model[—-]example[—-]takeaway/gi, "提问—原理—验证—结论")
    .replace(/geometric-control/gi, "几何秩序")
    .replace(/shot-question/gi, "提问镜头")
    .replace(/shot-model/gi, "原理镜头")
    .replace(/shot-example/gi, "验证镜头")
    .replace(/shot-takeaway/gi, "结论镜头")
    .replace(/asset\.generate\.video/gi, "AI 视频生成")
    .replace(/asset\.generate\.image/gi, "AI 图片生成")
    .replace(/asset\.search/gi, "图库检索")
    .replace(/manualReplacement/gi, "人工补充素材")
    .replace(/\bmeasured\b/gi, "舒缓克制")
    .replace(/\bmedium\b/gi, "适中")
    .replace(/\bfast\b/gi, "明快")
    .replace(/\bslow\b/gi, "舒缓")
    .replace(/本地\s+Provider/gi, "本地编辑能力")
    .replace(/本地编辑\s+Provider/gi, "本地编辑能力")
    .replace(/\bProvider\b/g, "素材能力")
    .replace(/素材能力\s+的能力/g, "素材能力")
    .replace(/本地编辑能力\s+的能力/g, "本地编辑能力")
    .replace(/本地编辑\s+素材能力/g, "本地编辑能力")
    .replace(/符合\s*素材能力\s*强项/g, "发挥所选画面能力的强项")
    .replace(/合同约束/g, "创作约束")
    .replace(/\s+(提问镜头|原理镜头|验证镜头|结论镜头)\s+/g, "$1");
}

export function proposalSourceLabel(providerId: string): string {
  if (providerId === "series-planner-v1") return "系列策划器";
  if (providerId === "api-topic-editor-v1") return "Codex 选题总编";
  if (providerId.includes("heuristic") || providerId.includes("deterministic")) return "本地规则提案";
  return "API 总编提案";
}

export const TOPIC_CATEGORY_LABELS = {
  society: "社会",
  "finance-career": "财经职场",
  technology: "科技",
  lifestyle: "生活",
  "health-sports": "健康体育",
  education: "教育",
  entertainment: "文娱",
  "local-culture": "华人地方",
  food: "美食",
  travel: "文旅出行",
  gaming: "游戏电竞",
  automotive: "汽车",
  "fashion-beauty": "时尚美妆",
  parenting: "亲子家庭",
  "agriculture-rural": "三农乡村",
} as const;

export function scoreSourceLabel(source: string): string {
  if (source.startsWith("人工维度评分")) return "人工评分";
  if (source.startsWith("历史记录")) return "历史评分";
  return source.replace(/\s*·\s*[a-z0-9._:-]+$/i, "");
}
