import { clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { NativeTextApi } from "../../shared/agent/provider-capabilities.js";
import type { ThinkingLevel } from "../../shared/agent/generated/contracts.js";

// 型号能力取自 Pi 锁定目录，并严格匹配协议、地址与型号 ID。

/** 精确型号的推理能力；只读投影，不进入保存命令或当前连接 JSON。 */
export interface TextThinkingCapability {
  levels: [ThinkingLevel, ...ThinkingLevel[]];
  defaultLevel: ThinkingLevel;
}

export type OpenAIChatModel = Model<"openai-responses">;

// Pi 1.4.0 原生默认推理档位（pi-coding-agent defaults.js 的 medium，SDK 根入口不导出）。
// 升级 SDK 时用原生 createAgentSession 行为对照复核，不在运行时读取 SDK 源码。
const PI_DEFAULT_THINKING_LEVEL = "medium";

// Realtime 是语音会话出口、Codex 是订阅专用路由，都不是本产品的文本对话型号。
const chatCatalog: ReadonlyMap<string, OpenAIChatModel> = new Map(
  builtinProviders().find(provider => provider.id === "openai")!.getModels()
    .filter(model => model.api === "openai-responses" && !model.id.startsWith("gpt-realtime-") && !model.id.includes("codex"))
    .map(model => [model.id, model as OpenAIChatModel]),
);

/** 供目录同步使用的候选文本型号（Pi 精确事实，不含账号可见性）。 */
export function openaiChatCatalog(): ReadonlyMap<string, OpenAIChatModel> {
  return chatCatalog;
}

/** 唯一能力查询：型号 + 官方有效地址都精确匹配才算已知；网关自定义地址不冒充已核实能力。 */
export function findOpenAIChatModel(modelId: string, baseUrl: string): OpenAIChatModel | null {
  const model = chatCatalog.get(modelId);
  if (!model) return null;
  const official = model.baseUrl ?? "https://api.openai.com/v1";
  return new URL(official).href.replace(/\/$/, "") === new URL(baseUrl).href.replace(/\/$/, "") ? model : null;
}

const nativeCatalog = new Map<string, Model<NativeTextApi>>();
for (const provider of builtinProviders()) {
  for (const model of provider.getModels()) {
    if (model.api !== "anthropic-messages" && model.api !== "openai-completions") continue;
    if (model.baseUrl) nativeCatalog.set(JSON.stringify([model.api, model.baseUrl.replace(/\/$/, ""), model.id]), model as Model<NativeTextApi>);
  }
}

export function findNativeTextModel(api: NativeTextApi | null, modelId: string, baseUrl: string): Model<NativeTextApi> | null {
  if (api === "openai-responses") return findOpenAIChatModel(modelId, baseUrl);
  return nativeCatalog.get(JSON.stringify([api, baseUrl.replace(/\/$/, ""), modelId])) ?? null;
}

// 已知型号给 Pi 实际支持列表与原生默认有效档位；未知身份返回 null，不冒充“不支持推理”。
export function thinkingCapabilityOf(known: Model<NativeTextApi> | null): TextThinkingCapability | null {
  if (!known) return null;
  if (!known.reasoning) return { levels: ["off"], defaultLevel: "off" };
  // Pi 对 reasoning 型号至少保留一个原生档位（off 或更高），合同要求非空列表。
  return {
    levels: getSupportedThinkingLevels(known) as [ThinkingLevel, ...ThinkingLevel[]],
    defaultLevel: clampThinkingLevel(known, PI_DEFAULT_THINKING_LEVEL),
  };
}

/** 配置档位转本请求实际档位：default 走 Pi 原生夹取；未知型号只能落到 off。 */
export function resolveThinkingLevel(
  known: Model<NativeTextApi> | null,
  requested: ThinkingLevel | "default" | undefined,
): ThinkingLevel {
  if (requested !== undefined && requested !== "default") return requested;
  return thinkingCapabilityOf(known)?.defaultLevel ?? "off";
}
