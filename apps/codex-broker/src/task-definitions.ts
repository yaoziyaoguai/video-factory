export const BROKER_TASK_KINDS = [
  "topic-ideas",
  "director-plan",
  "script-draft",
  "publish-copy",
  "visual-review",
] as const;
export type BrokerTaskKind = (typeof BROKER_TASK_KINDS)[number];

export interface BrokerTaskPrompt {
  version: string;
  directive: string;
  task: string;
  outputRules: string[];
  examples: string[];
}

const TOPIC_IDEAS_DIRECTIVE = [
  "你是严谨的中文短视频选题总编。先判断热点是否值得做视频，再提出角度；热度不等于视频价值。只输出 JSON 对象。",
  "判断时同时考虑视觉可表现性、证据可得性、普通观众收益、系列潜力、制作成本和合规风险。没有必要二创的普通通稿应放弃。",
  "不得编造原始热点中不存在的引语、人物表态、百分比、因果或采访素材；证据不足就使用问题句或观察角度。",
  "避免把灾害、伤亡、政治突发娱乐化。",
  "优先选择能长期连载、免费素材可覆盖、对普通人有具体价值的角度。",
].join("\n");

const SCREENWRITER_DIRECTIVE = [
  "你是面向中国短视频平台的创意编剧。交付不是文章，而是一份可拍、可朗读、可核验、可逐镜验收的制作合同。",
  "先给出一句 viewerPromise（观众看完具体获得什么），再写 narrativeArc，然后拆分视觉节拍；故事段落不等于镜头。",
  "20 到 30 秒内容通常需要 6 到 10 个视觉节拍；除有意停顿外，连续静态画面不得超过 3 秒。",
  "旁白用口语中文，句子短，第一镜前两秒建立具体冲突或结果预告，前六秒必须兑现一部分观众承诺。",
  "每场只承载一个可见动作或变化；visible_action 写观众实际看见什么发生变化，visual_prompt 写画面而不是抽象主题。",
  "每场必须给出屏幕文字、声音提示、成功条件和失败条件；成功条件必须能由导演或审片员从画面中判断。",
  "旁白按正常中文口播控制在每秒约 2 到 6 个汉字；宁可拆成更多短镜头，也不要用加速配音塞入长句。",
  "visual_strategy 只能是 stock（图库实拍）、image（图库图片）、generated（AI 生成）或 local（本地编辑卡片）。",
  "local 只允许文字、数字、清单、引语、来源说明、转场和片尾行动提示的排版揭示；不得要求它绘制定制插画、模拟真实物体、制造物理光影或完成真人动作。",
  "不得假设存在未在输入中列出的自有照片、采访、产品图或成对对照素材；需要这些素材时应改写为可检索或可生成的镜头，并在失败条件中明确素材缺口。",
  "不得编造数字、引语或当事人表态；证据不足时用问题句。",
  "输入含 editorial 时必须遵守其 verdict 和 guardrails；produce_image_story 应优先来源卡、数据卡与静态实证，不写成虚构现场。",
  "输入含 templateBlueprint 时，它是生产合同：按 storyStructure 组织叙事，按 shotSlots 规划镜头，并遵守 visualSystem、soundSystem、qualityRules 与 costPolicy。",
  "search_terms 是中文短词组，用于图库检索，不要放整句话。",
  "场景数在 5 到 24 之间，总时长贴近目标时长。",
  "只输出 JSON 对象，不要输出解释文字或 Markdown。",
].join("\n");

const DIRECTOR_PLAN_DIRECTIVE = [
  "你是短视频生产工作流里的总导演。导演不是素材配方，也不是最后套滤镜。",
  "你要先形成全片视觉圣经，再针对每个脚本场景独立选择最合适的素材 Provider。",
  "每个镜头先写中性的 Shot Spec：主体、环境、可见动作、逐秒动作、景别、机位、运镜、光线、连续性锚点、参考素材、负面约束和成功条件。",
  "逐秒动作使用 [0s-2s] 这类时间段，必须能在镜头时长内完成；不要用‘高级感’‘氛围感’代替可见动作。",
  "generationPrompt 是 Provider Compiler 根据 Shot Spec 生成的执行提示，只保留该模型需要执行的主体、动作、镜头、光线、声音和风格，不得混入版权、审批、成本或工作流说明。",
  "经济策略只给出成本上限，不规定免费素材和生成素材的比例。",
  "逐镜先判断观众必须实际看见什么，再依据每个 Provider 的 strengths 和 constraints 做选择；这些约束高于成本偏好。",
  "本地编辑卡片只能承载标题、数据、清单、引语、转场或片尾，不能满足需要看见真实人物、动作、地点或现场环境的镜头。",
  "本地编辑卡片也不能凭空绘制定制插画、真实物体、物理光影动画或成对实拍照片；输入未列出自有素材库存时，绝不能假设这些素材存在。",
  "当前本地编辑 Provider 只交付一张静态卡片，所有元素从首帧就存在，渲染器最多做整张画面的轻微推拉；不得在 temporalBeats 或 generationPrompt 中承诺逐字、逐项、箭头、图形或物件动画。",
  "deliveryType 是机器执行合同：本地卡片只能是 editorial_card；图库只能是 stock_video 或 stock_image；图片模型只能是 generated_image；视频模型只能是 generated_video。备选 Provider 也必须支持同一种交付类型。",
  "通用图库可以表现普通人物、动作和环境，但不能冒充具体事件、涉事人物或事发现场的证据。",
  "图库是检索而不是生成：只有常见、单一、容易搜到的动作才能选择图库；需要精确多步表演、物件状态严格变化或特定界面操作时，应选择生成式能力，或把镜头改写为诚实的说明画面。",
  "图库 query 使用 3 到 8 个具体英文概念，优先主体、动作和环境，不放运镜、光线、画幅、字幕安全区或整句提示词；同一组概念不得机械复用于相邻镜头。",
  "AI 生成画面只用于 illustrative 或 expressive 镜头，不得作为事实证据，并应避免肖像、品牌和地标误导。",
  "不设任何素材来源配额；只有当每个镜头都独立符合 Provider 能力时，才可以全部选择同一来源。",
  "preferredProviderId、rationale、query 和 generationPrompt 必须相互一致，alternativeProviderIds 也必须能真实承接该镜头。",
  "必须读取脚本中的 onScreenText 与 soundCue：构图要为真实屏幕文字留出安全区，声音提示只进入声音设计，不得误写成画面动作。",
  "只能使用输入提供的 Provider ID，必须覆盖每个场景且不得重复。",
  "evidence 镜头不得选择 AI 生成 Provider；不确定时优先真实素材并降低 confidence。",
  "输入含 editorial 时，其 guardrails 是硬约束；produce_image_story 不得把具体事件改造成生成式现场或当事人表演。",
  "输入含 templateBlueprint 时，它是生产合同：视觉圣经必须落实 visualSystem 和 soundSystem，逐镜方案必须对应 storyStructure、shotSlots、qualityRules 与 costPolicy。",
  "当付费镜头上限小于场景数时，其余镜头必须选择输入中的免费 Provider；绝不能把每个场景都指向付费 Provider。",
  "requestedProfileId 为 auto 时，根据题材选择最合适的非 auto 导演角色。",
  "只输出 JSON 对象，不要输出解释文字或 Markdown。",
].join("\n");

const PUBLISH_COPY_DIRECTIVE = [
  "你是中文短视频的发布文案编辑。标题与描述必须只基于输入脚本文案，不得引入新事实。",
  "标题不含引号、不含表情符号，不承诺未在脚本中出现的效果。",
  "描述用一到两句话概括内容价值，语气与平台习惯一致。",
  "hashtag 是不含 # 号、不含空白的中文短词。",
  "只输出 JSON 对象，不要输出解释文字或 Markdown。",
].join("\n");

const VISUAL_REVIEW_DIRECTIVE = [
  "你是短视频成片的视觉审片员。必须对照输入中的脚本、导演意图和时间线，再依据按时间顺序附带的 JPEG 帧与时间码判断。",
  "重点检查意图兑现、前六秒留存、构图、视觉连续性、节奏与变化、文字可读性和内容安全；看不到或无法确认的内容必须降低 confidence，不得臆测。",
  "必须逐场核对 visible_action、success_criteria、导演 successCriteria 与实际可见画面；任何未兑现或无法由采样帧确认的条件，都要在对应场景时间范围内留下 finding。",
  "采样静帧不能证明连续动作流畅、音效存在或口型同步；涉及这些条件时不得假装已确认，必须降低 confidence，并在无法排除问题时给出 revise。",
  "只要存在 critical、任一评分低于 60、或任一场景的核心成功条件未确认，就不得 recommendation=approve。",
  "每条 finding 必须绑定输入范围内的 timecodeMs，并给出可执行的修改建议。",
  "recommendation 只能是 approve、revise 或 reject；只输出 JSON 对象，不要输出解释文字或 Markdown。",
].join("\n");

const PLATFORM_NOTES: Record<string, string> = {
  douyin: "抖音：标题口语化、前三个字就要抓住注意力；话题标签 3 到 5 个。",
  shipinhao: "视频号：标题克制准确，面向转发场景；话题标签 1 到 3 个。",
  kuaishou: "快手：标题直白接地气；话题标签 2 到 4 个。",
  xiaohongshu: "小红书：标题像一条笔记标题；话题标签 3 到 5 个。",
  bilibili: "B 站：标题信息量优先；话题标签 1 到 3 个。",
};

export function taskPromptFor(kind: BrokerTaskKind, platform?: string): BrokerTaskPrompt {
  if (kind === "topic-ideas") {
    return {
      version: "video-factory/topic-editor-v2",
      directive: TOPIC_IDEAS_DIRECTIVE,
      task: "从实时热点中提出最多 8 个原创短视频角度。",
      outputRules: [
        "signalId 必须原样引用。",
        "track 必须是小写英文 slug，例如 sports-context。",
        "title 必须是编辑命题，不能原样复述热搜。",
        "hook 要在 2 秒内建立冲突，但只能使用输入中可验证的信息，不得假装有采访或独家画面。",
        "novelty、seriesPotential、monetization 必须填写 0-100 的整数。",
      ],
      examples: [
        "正例：高热度但只有通稿、缺少可验证画面时，rationale 明确建议做来源卡解读或放弃，而不是虚构现场。",
        "反例：因为热搜第一就直接生成当事人表演、灾难现场或未经证实的因果。",
      ],
    };
  }
  if (kind === "script-draft") {
    return {
      version: "video-factory/screenwriter-v4",
      directive: SCREENWRITER_DIRECTIVE,
      task: "为目标时长撰写可直接投产的分镜脚本。",
      outputRules: [
        "scenes.position 从 1 开始连续编号。",
        "顶层必须包含 viewerPromise、narrativeArc 和 scenes。",
        "每个场景必须包含 position、purpose、narration、duration、visual_strategy、visual_prompt、visible_action、on_screen_text、sound_cue、success_criteria、failure_conditions、search_terms。",
        "duration 单位是秒，所有场景时长之和需在目标时长的 0.6 到 1.4 倍之间。",
      ],
      examples: [
        "正例：visible_action='手从画面右侧拉开窗帘，桌面亮度明显升高'；success_criteria=['能看见手完成拉帘','杯子高光由暗变亮']。",
        "反例：visual_prompt='治愈、高级、有氛围感'，没有主体、动作、变化或可验收结果。",
      ],
    };
  }
  if (kind === "publish-copy") {
    const platformNote = PLATFORM_NOTES[platform ?? ""]
      ?? "平台未识别时使用中性、不夸张的标题与 2 到 4 个话题标签。";
    return {
      version: "video-factory/publish-editor-v1",
      directive: `${PUBLISH_COPY_DIRECTIVE}\n${platformNote}`,
      task: "为成片撰写平台发布标题、描述与话题标签。",
      outputRules: [
        "title 长度 1 到 30 字，description 长度 1 到 100 字。",
        "hashtags 数量 1 到 5 个，每个 1 到 16 字，不带 # 号、不含空白。",
      ],
      examples: [],
    };
  }
  if (kind === "visual-review") {
    return {
      version: "video-factory/visual-review-v3",
      directive: VISUAL_REVIEW_DIRECTIVE,
      task: "按时间顺序审查附带的关键帧并生成严格结构化视觉审片报告。",
      outputRules: [
        "顶层必须完整包含 version、summary、scores、findings、confidence、recommendation；version 必须固定为 video-factory/visual-review-v1。",
        "scores 必须完整包含 composition、continuity、pacing、legibility、safety，不得省略字段或增加字段。",
        "findings 中每项必须完整包含 timecodeMs、category、severity、description、suggestion。",
        "finding.category 只能是 composition、continuity、pacing、legibility、safety、other；severity 只能是 info、warning、critical。",
        "scores 的五项评分必须是 0 到 100 的整数。",
        "confidence 必须是 0 到 1 之间的数字。",
        "没有问题时 findings 输出空数组，不要虚构问题。",
        "只有五项评分均不低于 60 且没有 warning 或 critical finding 时才允许 recommendation=approve。",
      ],
      examples: [
        "正例：预期拉帘但关键帧里窗帘位置和照度都未变化，应在对应 timecode 标记意图未兑现并建议重生成该镜头。",
      ],
    };
  }
  return {
    version: "video-factory/director-v5",
    directive: DIRECTOR_PLAN_DIRECTIVE,
    task: "生成视觉圣经和逐镜素材路由。",
    outputRules: [
      "每个 shot 必须先完成结构化 Shot Spec，选择可执行的 deliveryType，再给出 query 与 generationPrompt。",
      "temporalBeats 至少两段，使用 [0s-2s] 形式；successCriteria 必须能从产出画面直接检查。",
    ],
    examples: [
      "正例：[0s-2s] 固定近景，手进入画面抓住窗帘；[2s-5s] 手向右拉开窗帘，日光扫过玻璃杯；[5s-6s] 镜头轻推近，杯沿高光稳定。",
      "反例：generationPrompt 混入‘必须通过审批、预算有限、禁止商用’等工作流文字，却没有明确主体动作。",
    ],
  };
}

const TOPIC_IDEAS_OUTPUT_SCHEMA = {
  type: "object",
  required: ["ideas"],
  additionalProperties: false,
  properties: {
    ideas: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        required: [
          "signalId", "title", "track", "audience", "painPoint", "hook", "rationale",
          "novelty", "seriesPotential", "monetization",
        ],
        additionalProperties: false,
        properties: {
          signalId: { type: "string" },
          title: { type: "string" },
          track: { type: "string" },
          audience: { type: "string" },
          painPoint: { type: "string" },
          hook: { type: "string" },
          rationale: { type: "string" },
          novelty: { type: "integer", minimum: 0, maximum: 100 },
          seriesPotential: { type: "integer", minimum: 0, maximum: 100 },
          monetization: { type: "integer", minimum: 0, maximum: 100 },
        },
      },
    },
  },
} as const;

const DIRECTOR_PLAN_OUTPUT_SCHEMA = {
  type: "object",
  required: ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"],
  additionalProperties: false,
  properties: {
    version: { type: "string", const: "video-factory/director-plan-v1" },
    requestedProfileId: { type: "string" },
    resolvedProfileId: { type: "string" },
    profileRationale: { type: "string" },
    visualBible: {
      type: "object",
      required: [
        "viewerPromise", "narrativeApproach", "motif", "pacing", "composition", "camera", "color",
        "continuity", "transitionGrammar", "sound", "antiPatterns",
      ],
      additionalProperties: false,
      properties: {
        viewerPromise: { type: "string" },
        narrativeApproach: { type: "string" },
        motif: { type: "string" },
        pacing: { type: "string" },
        composition: { type: "string" },
        camera: { type: "string" },
        color: { type: "string" },
        continuity: { type: "string" },
        transitionGrammar: { type: "string" },
        sound: { type: "string" },
        antiPatterns: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        required: [
          "scenePosition", "narrativeRole", "authenticityPolicy", "preferredProviderId",
          "deliveryType", "alternativeProviderIds", "subject", "environment", "visibleAction", "temporalBeats", "shotSize",
          "camera", "lighting", "negativeConstraints", "referenceRequirements", "successCriteria", "query",
          "generationPrompt", "rationale", "continuityNote", "confidence", "estimatedCostCny",
        ],
        additionalProperties: false,
        properties: {
          scenePosition: { type: "integer", minimum: 1 },
          narrativeRole: { type: "string" },
          authenticityPolicy: { type: "string", enum: ["evidence", "illustrative", "expressive"] },
          preferredProviderId: { type: "string" },
          deliveryType: {
            type: "string",
            enum: ["editorial_card", "stock_video", "stock_image", "generated_image", "generated_video"],
          },
          alternativeProviderIds: { type: "array", items: { type: "string" } },
          subject: { type: "string", minLength: 1 },
          environment: { type: "string", minLength: 1 },
          visibleAction: { type: "string", minLength: 1 },
          temporalBeats: { type: "array", minItems: 2, maxItems: 6, items: { type: "string", minLength: 1 } },
          shotSize: { type: "string", minLength: 1 },
          camera: { type: "string", minLength: 1 },
          lighting: { type: "string", minLength: 1 },
          negativeConstraints: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } },
          referenceRequirements: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
          successCriteria: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
          query: { type: "string", maxLength: 140 },
          generationPrompt: { type: "string" },
          rationale: { type: "string" },
          continuityNote: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          estimatedCostCny: { type: "number", minimum: 0 },
        },
      },
    },
  },
} as const;

const SCRIPT_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  required: ["viewerPromise", "narrativeArc", "scenes"],
  additionalProperties: false,
  properties: {
    viewerPromise: { type: "string", minLength: 1, maxLength: 200 },
    narrativeArc: { type: "string", minLength: 1, maxLength: 500 },
    scenes: {
      type: "array",
      minItems: 5,
      maxItems: 24,
      items: {
        type: "object",
        required: [
          "position", "purpose", "narration", "duration", "visual_strategy", "visual_prompt", "visible_action",
          "on_screen_text", "sound_cue", "success_criteria", "failure_conditions", "search_terms",
        ],
        additionalProperties: false,
        properties: {
          position: { type: "integer", minimum: 1 },
          purpose: { type: "string", minLength: 1 },
          narration: { type: "string", minLength: 1 },
          duration: { type: "number", exclusiveMinimum: 0 },
          visual_strategy: { type: "string", enum: ["stock", "image", "generated", "local"] },
          visual_prompt: { type: "string", minLength: 1 },
          visible_action: { type: "string", minLength: 1 },
          on_screen_text: { type: "string" },
          sound_cue: { type: "string", minLength: 1 },
          success_criteria: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1 } },
          failure_conditions: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", minLength: 1 } },
          search_terms: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1 } },
        },
      },
    },
  },
} as const;

const PUBLISH_COPY_OUTPUT_SCHEMA = {
  type: "object",
  required: ["title", "description", "hashtags"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 30 },
    description: { type: "string", minLength: 1, maxLength: 100 },
    hashtags: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: { type: "string", minLength: 1, maxLength: 16 },
    },
  },
} as const;

const VISUAL_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  required: ["version", "summary", "scores", "findings", "confidence", "recommendation"],
  additionalProperties: false,
  properties: {
    version: { type: "string", const: "video-factory/visual-review-v1" },
    summary: { type: "string", minLength: 1, maxLength: 1_000 },
    scores: {
      type: "object",
      required: ["composition", "continuity", "pacing", "legibility", "safety"],
      additionalProperties: false,
      properties: {
        composition: { type: "integer", minimum: 0, maximum: 100 },
        continuity: { type: "integer", minimum: 0, maximum: 100 },
        pacing: { type: "integer", minimum: 0, maximum: 100 },
        legibility: { type: "integer", minimum: 0, maximum: 100 },
        safety: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    findings: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        required: ["timecodeMs", "category", "severity", "description", "suggestion"],
        additionalProperties: false,
        properties: {
          timecodeMs: { type: "integer", minimum: 0 },
          category: {
            type: "string",
            enum: ["composition", "continuity", "pacing", "legibility", "safety", "other"],
          },
          severity: { type: "string", enum: ["info", "warning", "critical"] },
          description: { type: "string", minLength: 1, maxLength: 500 },
          suggestion: { type: "string", minLength: 1, maxLength: 500 },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    recommendation: { type: "string", enum: ["approve", "revise", "reject"] },
  },
} as const;

export function outputSchemaFor(kind: BrokerTaskKind): Record<string, unknown> {
  if (kind === "topic-ideas") return TOPIC_IDEAS_OUTPUT_SCHEMA;
  if (kind === "script-draft") return SCRIPT_DRAFT_OUTPUT_SCHEMA;
  if (kind === "publish-copy") return PUBLISH_COPY_OUTPUT_SCHEMA;
  if (kind === "visual-review") return VISUAL_REVIEW_OUTPUT_SCHEMA;
  return DIRECTOR_PLAN_OUTPUT_SCHEMA;
}

export function outputValidationErrorFor(kind: BrokerTaskKind, value: unknown): string | undefined {
  return schemaValidationError(outputSchemaFor(kind), value, "output")
    ?? semanticValidationErrorFor(kind, value);
}

function semanticValidationErrorFor(kind: BrokerTaskKind, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (kind === "script-draft" && Array.isArray(value.scenes)) {
    const positions = value.scenes.map((scene) => isRecord(scene) ? scene.position : undefined);
    const invalidIndex = positions.findIndex((position, index) => position !== index + 1);
    if (invalidIndex >= 0) return `output.scenes[${invalidIndex}].position must continue from 1 without gaps.`;
  }
  if (kind === "director-plan" && Array.isArray(value.shots)) {
    const seenPositions = new Set<number>();
    for (const [index, shot] of value.shots.entries()) {
      if (!isRecord(shot) || typeof shot.scenePosition !== "number") continue;
      if (seenPositions.has(shot.scenePosition)) {
        return `output.shots[${index}].scenePosition duplicates scene ${shot.scenePosition}.`;
      }
      seenPositions.add(shot.scenePosition);
    }
  }
  if (kind === "visual-review" && value.recommendation === "approve") {
    const scores = isRecord(value.scores) ? Object.values(value.scores) : [];
    if (scores.some((score) => typeof score === "number" && score < 60)) {
      return "output.recommendation cannot approve when a review score is below 60.";
    }
    if (Array.isArray(value.findings) && value.findings.some((finding) => (
      isRecord(finding) && (finding.severity === "warning" || finding.severity === "critical")
    ))) {
      return "output.recommendation cannot approve while warning or critical findings remain.";
    }
  }
  return undefined;
}

function schemaValidationError(
  schema: Record<string, unknown>,
  value: unknown,
  field: string,
): string | undefined {
  if (schema.const !== undefined && value !== schema.const) {
    return `${field} must equal ${JSON.stringify(schema.const)}.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${field} is not an allowed value.`;
  }

  const type = schema.type;
  if (type === "object") {
    if (!isRecord(value)) return `${field} must be an object.`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) return `${field}.${key} is required.`;
    }
    if (schema.additionalProperties === false) {
      const unexpected = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unexpected !== undefined) return `${field}.${unexpected} is not allowed.`;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || !isRecord(childSchema)) continue;
      const error = schemaValidationError(childSchema, value[key], `${field}.${key}`);
      if (error !== undefined) return error;
    }
    return undefined;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${field} must be an array.`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${field} must contain at least ${schema.minItems} entries.`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${field} must contain at most ${schema.maxItems} entries.`;
    }
    if (isRecord(schema.items)) {
      for (const [index, entry] of value.entries()) {
        const error = schemaValidationError(schema.items, entry, `${field}[${index}]`);
        if (error !== undefined) return error;
      }
    }
    return undefined;
  }
  if (type === "string") {
    if (typeof value !== "string") return `${field} must be a string.`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return `${field} is shorter than ${schema.minLength} characters.`;
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return `${field} is longer than ${schema.maxLength} characters.`;
    }
    return undefined;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a finite number.`;
    if (type === "integer" && !Number.isInteger(value)) return `${field} must be an integer.`;
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${field} must be at least ${schema.minimum}.`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${field} must be at most ${schema.maximum}.`;
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      return `${field} must be greater than ${schema.exclusiveMinimum}.`;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
