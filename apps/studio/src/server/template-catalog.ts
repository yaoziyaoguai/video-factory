import { parseProductionTemplate, type ProductionTemplate, type ProductionTemplateInput } from "@video-factory/template-core";

const CREATED_AT = "2026-08-27T00:00:00.000Z";

interface TemplateSeed {
  id: string;
  name: string;
  description: string;
  category: string;
  durationSeconds: number;
  automationLevel: ProductionTemplateInput["automationLevel"];
  beats: Array<[id: string, label: string, purpose: string]>;
  visual: [composition: string, colorIntent: string, pacing: ProductionTemplateInput["visualSystem"]["pacing"]];
  sound: [voiceIntent: string, pace: ProductionTemplateInput["soundSystem"]["pace"], musicIntent: string];
  qualityDimension: ProductionTemplateInput["qualityRules"][number]["dimension"];
}

const SEEDS: TemplateSeed[] = [
  {
    id: "trend-fact-brief",
    name: "热点事实解读",
    description: "先核事实，再用一个清晰角度解释事件为什么值得关注。",
    category: "trend",
    durationSeconds: 36,
    automationLevel: "assisted",
    beats: [["hook", "事实钩子", "给出已核验且有张力的事实"], ["context", "补足语境", "说明来龙去脉和信息边界"], ["meaning", "解释影响", "回答这件事与观众有什么关系"], ["close", "克制收束", "留下可验证的结论而非煽动"]],
    visual: ["新闻证据优先，人物和地点保持可识别", "中性色为主，警示信息用红色点缀", "dynamic"],
    sound: ["冷静、可信、不过度表演", "medium", "低存在感新闻节奏"],
    qualityDimension: "factual",
  },
  {
    id: "knowledge-explainer",
    name: "知识解释",
    description: "把一个复杂问题拆成观众能理解和复述的因果链。",
    category: "knowledge",
    durationSeconds: 42,
    automationLevel: "assisted",
    beats: [["question", "提出问题", "从日常误解切入"], ["model", "建立模型", "给出最少但足够的核心概念"], ["example", "具体例子", "用生活场景验证解释"], ["takeaway", "一句带走", "形成可复述结论"]],
    visual: ["一个镜头只承载一个概念，图形与实拍交替", "自然底色配高对比知识标记", "measured"],
    sound: ["聪明但不居高临下", "medium", "简洁轻盈的节拍"],
    qualityDimension: "factual",
  },
  {
    id: "photo-story",
    name: "照片故事",
    description: "围绕有限照片建立时间、人物和情绪变化。",
    category: "photo",
    durationSeconds: 30,
    automationLevel: "assisted",
    beats: [["arrival", "第一眼", "用最有信息量的照片建立场景"], ["detail", "细节推进", "从局部发现关系或变化"], ["turn", "情绪转折", "让前后照片形成意义差"], ["memory", "余韵", "用一句旁白把记忆留住"]],
    visual: ["尊重照片原始比例，用运动和留白制造呼吸", "从照片取色，避免滤镜覆盖真实质感", "calm"],
    sound: ["亲近、像在讲一段真实记忆", "slow", "稀疏环境声和轻音乐"],
    qualityDimension: "copyright",
  },
  {
    id: "product-demo",
    name: "产品教程",
    description: "以真实操作和前后结果证明工具或产品解决了什么。",
    category: "tutorial",
    durationSeconds: 45,
    automationLevel: "assisted",
    beats: [["pain", "真实问题", "展示使用前的具体阻碍"], ["steps", "关键步骤", "只保留完成任务必须的操作"], ["proof", "结果证明", "展示可核对的前后差异"], ["limit", "边界说明", "说明适用条件和限制"]],
    visual: ["界面和产品细节必须可辨识，指示动作精确", "产品本色配功能强调色", "dynamic"],
    sound: ["清楚、直接、行动导向", "fast", "节奏明确但不盖过讲解"],
    qualityDimension: "technical",
  },
  {
    id: "human-mini-doc",
    name: "人物微纪录",
    description: "用行动、环境和一句关键表达建立真实人物弧光。",
    category: "documentary",
    durationSeconds: 60,
    automationLevel: "manual",
    beats: [["world", "人物所在", "先看环境和日常行动"], ["desire", "正在追求", "让目标从行动而非标签中出现"], ["friction", "真实阻力", "保留矛盾和不完美"], ["gesture", "一个动作", "用具体动作完成情绪收束"]],
    visual: ["观察式镜头，优先自然光和真实空间关系", "肤色准确，保留环境本来的颜色", "calm"],
    sound: ["尊重人物语气，少用全知旁白", "slow", "环境声优先，音乐延后进入"],
    qualityDimension: "artistic",
  },
  {
    id: "ranked-comparison",
    name: "榜单对比",
    description: "用一致标准比较多个选项，避免只给结论不给依据。",
    category: "comparison",
    durationSeconds: 40,
    automationLevel: "automatic",
    beats: [["criteria", "先讲标准", "告诉观众按什么比较"], ["contrast", "快速对照", "保持每项证据结构一致"], ["winner", "条件结论", "给出不同需求下的选择"], ["caveat", "重要例外", "说明榜单不适用的情况"]],
    visual: ["统一机位和信息框架，差异项使用可扫描标记", "多色分类但保持背景克制", "dynamic"],
    sound: ["利落、公平、有判断", "fast", "轻量计分节奏"],
    qualityDimension: "platform",
  },
];

export const BUILTIN_TEMPLATES: readonly ProductionTemplate[] = SEEDS.map((seed) => parseProductionTemplate(toTemplate(seed)));

function toTemplate(seed: TemplateSeed): ProductionTemplateInput {
  const storyStructure = seed.beats.map(([id, label, purpose]) => ({ id, label, purpose, required: true }));
  const shotSlots = createShotSlots(seed);
  return {
    id: seed.id,
    version: 1,
    status: "published",
    name: seed.name,
    description: seed.description,
    category: seed.category,
    platforms: ["douyin", "xiaohongshu", "shipinhao", "bilibili"],
    durationSeconds: seed.durationSeconds,
    automationLevel: seed.automationLevel,
    storyStructure,
    shotSlots,
    visualSystem: {
      composition: seed.visual[0],
      colorIntent: seed.visual[1],
      subtitleDensity: seed.id === "photo-story" || seed.id === "human-mini-doc" ? "low" : "medium",
      pacing: seed.visual[2],
    },
    soundSystem: { voiceIntent: seed.sound[0], pace: seed.sound[1], musicIntent: seed.sound[2] },
    qualityRules: [
      { id: "content-safety", label: "内容与平台安全", dimension: "platform", required: true, threshold: 90 },
      { id: `primary-${seed.qualityDimension}`, label: "模板核心质量", dimension: seed.qualityDimension, required: true, threshold: 80 },
    ],
    capabilityRequirements: [
      { capability: "script.draft", required: true },
      { capability: "storyboard.plan", required: true },
      { capability: "asset.prepare", required: true },
      { capability: "voice.synthesize", required: true },
      { capability: "video.render", required: true },
      { capability: "quality.review", required: true },
    ],
    costPolicy: { currency: "CNY", maxCost: seed.id === "human-mini-doc" ? 20 : 8, maxPaidShots: seed.id === "human-mini-doc" ? 3 : 1 },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function createShotSlots(seed: TemplateSeed): ProductionTemplateInput["shotSlots"] {
  const slotCount = Math.max(6, Math.min(14, Math.round(seed.durationSeconds / 4)));
  const beatOccurrences = new Map<string, number>();
  const purposes = ["建立具体画面", "展示动作或变化", "补充关键细节", "用结果或反应兑现"];
  return Array.from({ length: slotCount }, (_, index) => {
    const beatIndex = Math.min(seed.beats.length - 1, Math.floor(index * seed.beats.length / slotCount));
    const [beatId, label] = seed.beats[beatIndex]!;
    const occurrence = (beatOccurrences.get(beatId) ?? 0) + 1;
    beatOccurrences.set(beatId, occurrence);
    return {
      id: `shot-${beatId}-${occurrence}`,
      beatId,
      purpose: `${label} · ${purposes[index % purposes.length]}`,
      durationSeconds: Math.max(2, Math.round(seed.durationSeconds / slotCount)),
      allowedCapabilities: ["asset.search", "asset.generate.image", "asset.generate.video"],
      manualReplacement: true,
    };
  });
}
