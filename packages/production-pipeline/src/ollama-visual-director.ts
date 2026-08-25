import { VISUAL_DIRECTOR_PROFILES, type VisualDirectorAgent, type VisualDirectorAgentInput } from "./visual-director.js";

export interface OllamaVisualDirectorAgentOptions {
  endpoint?: string;
  model?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export class OllamaVisualDirectorAgent implements VisualDirectorAgent {
  readonly id = "ollama-visual-director-v1";
  private readonly endpoint: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OllamaVisualDirectorAgentOptions = {}) {
    this.endpoint = (options.endpoint ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = options.model ?? "qwen3:8b";
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  async plan(input: VisualDirectorAgentInput): Promise<unknown> {
    const response = await this.fetcher(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: directorPlanSchema,
        options: { temperature: 0.42, top_p: 0.86, num_predict: 3200 },
        messages: [
          {
            role: "system",
            content: [
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
              "只输出符合 JSON Schema 的 JSON，不要输出解释文字。",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "生成视觉圣经和逐镜素材路由",
              directorProfiles: VISUAL_DIRECTOR_PROFILES,
              ...input,
            }),
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Ollama visual director returned HTTP ${response.status}.`);
    const body = await response.json() as { message?: { content?: string } };
    const content = body.message?.content;
    if (!content) throw new Error("Ollama visual director returned an empty response.");
    try {
      return JSON.parse(content);
    } catch {
      throw new Error("Ollama visual director returned invalid JSON.");
    }
  }
}

const profileIds = [
  "auto",
  "documentary-observer",
  "quiet-humanism",
  "urban-poetic",
  "chromatic-storytelling",
  "geometric-control",
  "suspense-staging",
] as const;

const resolvedProfileIds = profileIds.filter((id) => id !== "auto");

const directorPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "requestedProfileId", "resolvedProfileId", "profileRationale", "visualBible", "shots"],
  properties: {
    version: { type: "string", const: "video-factory/director-plan-v1" },
    requestedProfileId: { type: "string", enum: profileIds },
    resolvedProfileId: { type: "string", enum: resolvedProfileIds },
    profileRationale: { type: "string" },
    visualBible: {
      type: "object",
      additionalProperties: false,
      required: ["narrativeApproach", "pacing", "composition", "camera", "color", "continuity", "sound"],
      properties: Object.fromEntries([
        "narrativeApproach", "pacing", "composition", "camera", "color", "continuity", "sound",
      ].map((key) => [key, { type: "string" }])),
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "scenePosition", "narrativeRole", "authenticityPolicy", "preferredProviderId",
          "alternativeProviderIds", "query", "generationPrompt", "rationale", "continuityNote",
          "confidence", "estimatedCostCny",
        ],
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
