export const RUN_NODE_LABELS: Record<string, string> = {
  brief: "内容简报",
  script: "脚本",
  "reference-grammar": "参考视频风格分析",
  "visual-direction": "导演方案",
  "asset-candidates": "候选素材",
  "asset-semantic-rank": "候选画面排序",
  assets: "画面",
  "asset-source-review": "生成画面预检",
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
    "codex-screenwriter-v1": "AI 编剧",
    "api-visual-director-v1": "AI 视觉导演",
    "codex-reference-grammar-v1": "AI 参考视频分析",
    "codex-asset-ranker-v1": "AI 候选画面排序",
    "asset-candidate-search-v1": "图库候选搜索",
    "codex-publish-copy-v1": "AI 发行编辑",
    "ai-shot-router-v1": "AI 逐镜选择画面来源",
    "human-editor": "人工编辑",
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
    "codex-visual-review-v1": "AI 视觉审片",
    "glm-visual-review-v1": "GLM-5.3-Flash 视觉审片",
    openai: "AI 创作服务",
    pexels: "Pexels 图库",
    pixabay: "Pixabay 图库",
    local: "本地编辑画面",
    minimax: "MiniMax",
    "minimax-tts-v1": "MiniMax 中文配音",
    seedance: "Seedance",
  } as Record<string, string>)[providerId];
}

export function providerModelLabel(
  provider: { defaultModelId?: string; modelProfiles?: Array<{ id: string; label: string }> } | undefined,
  modelId?: string,
): string {
  if (!modelId) return "自动选择";
  return provider?.modelProfiles?.find((model) => model.id === modelId)?.label ?? "未识别模型";
}

export function catalogModelLabel(providers: Array<{ modelProfiles?: Array<{ id: string; label: string }> }>, modelId?: string): string | undefined {
  if (!modelId) return undefined;
  for (const provider of providers) {
    const label = provider.modelProfiles?.find((model) => model.id === modelId)?.label;
    if (label) return label;
  }
  return undefined;
}

export function humanizeCreativeText(value: string): string {
  return value
    .replace(/knowledge-failed-intuition/gi, "打破直觉")
    .replace(/knowledge-question/gi, "明确问题")
    .replace(/knowledge-cause/gi, "解释原因")
    .replace(/knowledge-chain/gi, "补全因果")
    .replace(/knowledge-example-setup/gi, "建立验证条件")
    .replace(/knowledge-example-change/gi, "展示变量变化")
    .replace(/knowledge-rule/gi, "提炼判断规则")
    .replace(/knowledge-use/gi, "落地操作")
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
    .replace(/\bgenerated_image\b/gi, "AI 图片生成")
    .replace(/\bgenerated_video\b/gi, "AI 视频生成")
    .replace(/\bstock_video\b/gi, "图库实拍视频")
    .replace(/\beditorial_card\b/gi, "主动排版画面")
    .replace(/\bon_screen_text\b/gi, "屏幕文字")
    .replace(/REUSE_ONLY\s+scene\s+(\d+)/gi, "复用镜头 $1")
    .replace(/\bblocking\b/gi, "必须修改的问题")
    .replace(/\bAIGC\b/gi, "AI 内容声明")
    .replace(/AI 编剧短视频结构/g, "提问—解释—验证—结论")
    .replace(/manualReplacement/gi, "人工补充素材")
    .replace(/\bmeasured\b/gi, "舒缓克制")
    .replace(/\bmedium\b/gi, "适中")
    .replace(/\bfast\b/gi, "明快")
    .replace(/\bslow\b/gi, "舒缓")
    .replace(/合同约束/g, "创作约束")
    .replace(/\s+(提问镜头|原理镜头|验证镜头|结论镜头)\s+/g, "$1");
}

export function creatorFacingTechnicalText(value?: string): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/VideoFactory generated script; human review required before publishing\.?/gi, "AI 生成脚本；发布前需要人工核对事实与表述。")
    .replace(/License snapshot is stored per scene asset in this plan\.?/gi, "本方案按镜头保存了每项素材的授权记录。")
    .replace(/Asset rights require review\.?/gi, "素材使用权需要人工核对。")
    .replace(/Locally generated narration; verify the selected voice provider terms\.?/gi, "本机生成的配音；发布前需核对所选配音服务的使用条款。")
    .replace(/VideoFactory voice timeline metadata\.?/gi, "配音时间轴记录。")
    .replace(/Composite output; see the linked asset and voiceover plans for source terms\.?/gi, "合成成片；素材与配音的来源条款请查看关联的画面和配音方案。")
    .replace(/VideoFactory render metadata\.?/gi, "成片渲染记录。")
    .replace(/VideoFactory technical review result\.?/gi, "机器质检结果。")
    .replace(/Immutable execution trace containing the exact prompt, prompt pack, provider, and model; no credentials are stored\.?/gi, "保存了本次使用的提示、配置、服务和模型，不包含任何密钥。")
    .replace(/AI-directed per-shot asset plan with actual provider provenance\.?/gi, "按导演逐镜方案生成的画面清单，并保留每个镜头的实际来源。")
    .replace(/External generation task IDs retained for audit\.?/gi, "保留生成任务编号，便于核对服务状态与账单。")
    .replace(/AI-generated (?:image|video) selected by the director plan; review terms, likeness rights, and AIGC disclosure\.?/gi, "由导演方案选中的 AI 画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/AI-generated (?:image|video); review provider terms, likeness rights, and AIGC disclosure before publishing\.?/gi, "AI 生成画面；发布前需核对使用条款、肖像权和 AI 内容声明。")
    .replace(/AI-generated script; facts and claims require human review before publication\.?/gi, "AI 生成脚本；发布前需要人工核对事实与表述。")
    .replace(/Independent role audit and bounded repair history; credentials and hidden reasoning are not stored\.?/gi, "保存独立质量复核与最多三轮修订记录，不包含密钥或模型内部推理。")
    .replace(/Preview-only candidate metadata; no media was downloaded by this node\.?/gi, "只保存候选素材信息，这一步没有下载素材。")
    .replace(/Candidate ranking only; no source media was downloaded or altered\.?/gi, "只保存候选排序结果，没有下载或修改原始素材。")
    .replace(/Series Bible/gi, "系列设定")
    .replace(/\bCanon\b/gi, "已确认内容")
    .replace(/\bCodex\b/gi, "AI")
    .replace(/\bAgent\b/gi, "AI")
    .replace(/\bProvider\b/gi, "服务")
    .replace(/\bBroker\b/gi, "AI 服务")
    .replace(/\bSchema\b/gi, "数据格式")
    .replace(/\bManifest\b/gi, "资源清单")
    .replace(/\bFallback\b/gi, "备用方案")
    .replace(/\btaskId\b/gi, "任务编号")
    .replace(/manualReplacement/gi, "人工补充素材")
    .replace(/primary\s+服务\s+timed\s+out/gi, "首选服务响应超时")
    .replace(/服务\s+timed\s+out/gi, "服务响应超时")
    .replace(/服务\s+unavailable/gi, "服务暂时不可用")
    .replace(/\b[a-z][a-z0-9]*(?:[-_.:][a-z0-9]+)+-v\d+\b/gi, "内部能力")
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
  if (providerId === "api-topic-editor-v1") return "AI 选题总编";
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
