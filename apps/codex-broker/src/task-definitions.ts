export const BROKER_TASK_KINDS = ["topic-ideas", "director-plan", "script-draft", "publish-copy"] as const;
export type BrokerTaskKind = (typeof BROKER_TASK_KINDS)[number];

interface BrokerTaskPrompt {
  directive: string;
  task: string;
  outputRules: string[];
}

const TOPIC_IDEAS_DIRECTIVE = [
  "你是严谨的中文短视频选题总编。只输出 JSON 对象。",
  "不得编造原始热点中不存在的引语、人物表态、百分比、因果或采访素材；证据不足就使用问题句或观察角度。",
  "避免把灾害、伤亡、政治突发娱乐化。",
  "优先选择能长期连载、免费素材可覆盖、对普通人有具体价值的角度。",
].join("\n");

const SCREENWRITER_DIRECTIVE = [
  "你是中文短视频的编剧。脚本必须可拍、可朗读、可核验。",
  "旁白用口语中文，句子短，第一场前两秒建立钩子。",
  "每场只承载一个可拍摄的视觉动作；visual_prompt 描述观众实际看见的画面。",
  "visual_strategy 只能是 stock（图库实拍）、image（图库图片）、local（本地编辑卡片）。",
  "不得编造数字、引语或当事人表态；证据不足时用问题句。",
  "search_terms 是中文短词组，用于图库检索，不要放整句话。",
  "场景数在 3 到 10 之间，总时长贴近目标时长。",
  "只输出 JSON 对象，不要输出解释文字或 Markdown。",
].join("\n");

const DIRECTOR_PLAN_DIRECTIVE = [
  "你是短视频生产工作流里的总导演。导演不是素材配方，也不是最后套滤镜。",
  "你要先形成全片视觉圣经，再针对每个脚本场景独立选择最合适的素材 Provider。",
  "经济策略只给出成本上限，不规定免费素材和生成素材的比例。",
  "逐镜先判断观众必须实际看见什么，再依据每个 Provider 的 strengths 和 constraints 做选择；这些约束高于成本偏好。",
  "本地编辑卡片只能承载标题、数据、清单、引语、转场或片尾，不能满足需要看见真实人物、动作、地点或现场环境的镜头。",
  "通用图库可以表现普通人物、动作和环境，但不能冒充具体事件、涉事人物或事发现场的证据。",
  "AI 生成画面只用于 illustrative 或 expressive 镜头，不得作为事实证据，并应避免肖像、品牌和地标误导。",
  "不设任何素材来源配额；只有当每个镜头都独立符合 Provider 能力时，才可以全部选择同一来源。",
  "preferredProviderId、rationale、query 和 generationPrompt 必须相互一致，alternativeProviderIds 也必须能真实承接该镜头。",
  "只能使用输入提供的 Provider ID，必须覆盖每个场景且不得重复。",
  "evidence 镜头不得选择 AI 生成 Provider；不确定时优先真实素材并降低 confidence。",
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
      directive: TOPIC_IDEAS_DIRECTIVE,
      task: "从实时热点中提出最多 8 个原创短视频角度。",
      outputRules: [
        "signalId 必须原样引用。",
        "track 必须是小写英文 slug，例如 sports-context。",
        "title 必须是编辑命题，不能原样复述热搜。",
        "hook 要在 2 秒内建立冲突，但只能使用输入中可验证的信息，不得假装有采访或独家画面。",
        "novelty、seriesPotential、monetization 必须填写 0-100 的整数。",
      ],
    };
  }
  if (kind === "script-draft") {
    return {
      directive: SCREENWRITER_DIRECTIVE,
      task: "为目标时长撰写可直接投产的分镜脚本。",
      outputRules: [
        "scenes.position 从 1 开始连续编号。",
        "每个场景必须包含 position、narration、duration、visual_strategy、visual_prompt、search_terms。",
        "duration 单位是秒，所有场景时长之和需在目标时长的 0.6 到 1.4 倍之间。",
      ],
    };
  }
  if (kind === "publish-copy") {
    const platformNote = PLATFORM_NOTES[platform ?? ""]
      ?? "平台未识别时使用中性、不夸张的标题与 2 到 4 个话题标签。";
    return {
      directive: `${PUBLISH_COPY_DIRECTIVE}\n${platformNote}`,
      task: "为成片撰写平台发布标题、描述与话题标签。",
      outputRules: [
        "title 长度 1 到 30 字，description 长度 1 到 100 字。",
        "hashtags 数量 1 到 5 个，每个 1 到 16 字，不带 # 号、不含空白。",
      ],
    };
  }
  return {
    directive: DIRECTOR_PLAN_DIRECTIVE,
    task: "生成视觉圣经和逐镜素材路由。",
    outputRules: [],
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
          novelty: { type: "number" },
          seriesPotential: { type: "number" },
          monetization: { type: "number" },
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
      required: ["narrativeApproach", "pacing", "composition", "camera", "color", "continuity", "sound"],
      additionalProperties: false,
      properties: {
        narrativeApproach: { type: "string" },
        pacing: { type: "string" },
        composition: { type: "string" },
        camera: { type: "string" },
        color: { type: "string" },
        continuity: { type: "string" },
        sound: { type: "string" },
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        required: [
          "scenePosition", "narrativeRole", "authenticityPolicy", "preferredProviderId",
          "alternativeProviderIds", "query", "generationPrompt", "rationale", "continuityNote",
          "confidence", "estimatedCostCny",
        ],
        additionalProperties: false,
        properties: {
          scenePosition: { type: "integer", minimum: 1 },
          narrativeRole: { type: "string" },
          authenticityPolicy: { type: "string", enum: ["evidence", "illustrative", "expressive"] },
          preferredProviderId: { type: "string" },
          alternativeProviderIds: { type: "array", items: { type: "string" } },
          query: { type: "string" },
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
  required: ["scenes"],
  additionalProperties: false,
  properties: {
    scenes: {
      type: "array",
      minItems: 3,
      maxItems: 10,
      items: {
        type: "object",
        required: ["position", "narration", "duration", "visual_strategy", "visual_prompt", "search_terms"],
        additionalProperties: false,
        properties: {
          position: { type: "integer", minimum: 1 },
          narration: { type: "string", minLength: 1 },
          duration: { type: "number", exclusiveMinimum: 0 },
          visual_strategy: { type: "string", enum: ["stock", "image", "local"] },
          visual_prompt: { type: "string", minLength: 1 },
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

export function outputSchemaFor(kind: BrokerTaskKind): Record<string, unknown> {
  if (kind === "topic-ideas") return TOPIC_IDEAS_OUTPUT_SCHEMA;
  if (kind === "script-draft") return SCRIPT_DRAFT_OUTPUT_SCHEMA;
  if (kind === "publish-copy") return PUBLISH_COPY_OUTPUT_SCHEMA;
  return DIRECTOR_PLAN_OUTPUT_SCHEMA;
}
