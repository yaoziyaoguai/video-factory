export const RUN_NODE_LABELS: Record<string, string> = {
  brief: "内容简报",
  script: "脚本",
  "visual-direction": "导演方案",
  assets: "画面",
  voice: "配音",
  render: "渲染",
  "technical-review": "机器质检",
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
    "video-factory-ts-v1": "VideoFactory 本地编排",
    "python-template-v1": "本地模板脚本",
    "codex-screenwriter-v1": "Codex 编剧",
    "api-visual-director-v1": "Codex 视觉导演",
    "codex-publish-copy-v1": "Codex 发行编辑",
    "ai-shot-router-v1": "AI 逐镜路由",
    "local-editorial-v1": "本地编辑画面",
    "pexels-stock-v1": "Pexels 图库",
    "pixabay-stock-v1": "Pixabay 图库",
    "macos-say-v1": "macOS 系统配音",
    "python-ffmpeg-v1": "FFmpeg 本地渲染",
    "python-technical-review-v1": "本地机器质检",
  } as Record<string, string>)[providerId] ?? providerId;
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
