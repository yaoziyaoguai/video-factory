export const RUN_NODE_LABELS: Record<string, string> = {
  brief: "内容简报",
  script: "脚本",
  "reference-grammar": "参考视频风格分析",
  "visual-direction": "导演方案",
  "asset-candidates": "候选素材",
  "asset-semantic-rank": "候选画面排序",
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
    "codex-asset-ranker-v1": "Codex 候选画面排序",
    "asset-candidate-search-v1": "图库候选搜索",
    "codex-publish-copy-v1": "Codex 发行编辑",
    "ai-shot-router-v1": "AI 逐镜选择画面来源",
    "local-editorial-v1": "本地编辑画面",
    "pexels-stock-v1": "Pexels 图库",
    "pixabay-stock-v1": "Pixabay 图库",
    "seedream-image-v1": "Seedream 图片生成",
    "seedance-video-v1": "Seedance 视频生成",
    "wan-video-v1": "百炼 · 通义万相视频",
    "hailuo-video-v1": "MiniMax 视频生成",
    "macos-say-v1": "macOS 系统配音",
    "python-ffmpeg-v1": "FFmpeg 本地渲染",
    "python-technical-review-v1": "本地机器质检",
    "codex-visual-review-v1": "Codex 视觉审片",
    "glm-visual-review-v1": "GLM-5.3-Flash 视觉审片",
    openai: "Codex",
    pexels: "Pexels 图库",
    pixabay: "Pixabay 图库",
    local: "本地编辑画面",
    minimax: "MiniMax",
    "minimax-tts-v1": "MiniMax 中文配音",
    seedance: "Seedance",
  } as Record<string, string>)[providerId] ?? providerId;
}

export function providerModelLabel(
  provider: { defaultModelId?: string; modelProfiles?: Array<{ id: string; label: string }> } | undefined,
  modelId?: string,
): string {
  if (!modelId) return "自动选择";
  return provider?.modelProfiles?.find((model) => model.id === modelId)?.label ?? modelId;
}

export function catalogModelLabel(providers: Array<{ modelProfiles?: Array<{ id: string; label: string }> }>, modelId?: string): string | undefined {
  if (!modelId) return undefined;
  for (const provider of providers) {
    const label = provider.modelProfiles?.find((model) => model.id === modelId)?.label;
    if (label) return label;
  }
  return modelId;
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

export function creatorFacingTechnicalText(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/Immutable execution trace containing the exact prompt, prompt pack, provider, and model; no credentials are stored\.?/gi, "保存了本次使用的提示、配置、服务和模型，不包含任何密钥。")
    .replace(/AI-directed per-shot asset plan with actual provider provenance\.?/gi, "按导演逐镜方案生成的画面清单，并保留每个镜头的实际来源。")
    .replace(/External generation task IDs retained for audit\.?/gi, "保留生成任务编号，便于核对服务状态与账单。")
    .replace(/AI-generated (?:image|video) selected by the director plan; review terms, likeness rights, and AIGC disclosure\.?/gi, "由导演方案选中的 AI 画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/AI-generated (?:image|video); review provider terms, likeness rights, and AIGC disclosure before publishing\.?/gi, "AI 生成画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/Series Bible/gi, "系列设定")
    .replace(/\bCanon\b/gi, "已确认内容")
    .replace(/\bAgent\b/gi, "AI")
    .replace(/\bProvider\b/gi, "服务")
    .replace(/\bMCP\b/gi, "标准接口")
    .replace(/\bCode Plan\b/gi, "订阅额度")
    .replace(/\bTTS API\b/gi, "云端配音服务")
    .replace(/\bAPI\b/gi, "服务接口")
    .replace(/\bSQLite\b/gi, "本地历史记录")
    .replace(/xhigh\s*推理/gi, "深入推理")
    .replace(/阻断门禁/g, "不通过则要求修改")
    .replace(/技术门禁/g, "技术检查")
    .replace(/产物校验/g, "文件校验")
    .replace(/结构化输出/g, "按固定格式交付")
    .replace(/绿灯审计/g, "开拍前复核")
    .replace(/本地生成/g, "在本机生成")
    .replace(/异步生成/g, "后台生成")
    .replace(/统一任务协议/g, "统一调用");
}

export function reasoningEffortLabel(value: unknown): string {
  if (value === "none" || value === "minimal" || value === "low") return "快速判断";
  if (value === "medium") return "标准推理";
  if (value === "high" || value === "xhigh") return "深入推理";
  if (value === "max" || value === "ultra") return "最高强度推理";
  return "由服务自动选择";
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
  if (source.startsWith("人工维度评分") || source.startsWith("录入时估分")) return "录入时估分";
  if (source.startsWith("历史记录")) return "历史评分";
  return source.replace(/\s*·\s*[a-z0-9._:-]+$/i, "");
}
