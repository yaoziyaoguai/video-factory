export type ModelProtocol = "openai-chat-completions" | "anthropic-messages";
export type ModelUnderstandingCapability = "text" | "image" | "audio";

export interface ModelConnectionInput {
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  modelId: string;
  apiKey: string;
  capabilities: ModelUnderstandingCapability[];
  maxOutputTokens: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  thinkingBudget?: number;
}

export interface ModelConnection extends Omit<ModelConnectionInput, "apiKey"> {
  id: string;
  socketName: string;
  enabled: boolean;
  credentialConfigured: boolean;
}

// 这是连接合同，不是模型能力认证。是否真的能看图、听音频仍由实际请求证据确认。
export function parseModelConnectionInput(value: unknown): ModelConnectionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型配置必须是对象。");
  const input = value as Record<string, unknown>;
  const text = (name: string, max: number): string => {
    const item = input[name];
    if (typeof item !== "string" || !item.trim() || item.trim().length > max || /[\u0000-\u001f]/.test(item)) {
      throw new Error(`模型配置 ${name} 无效。`);
    }
    return item.trim();
  };
  const label = text("label", 100);
  const modelId = text("modelId", 160);
  const apiKey = text("apiKey", 4096);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(modelId)) throw new Error("上游模型 ID 格式无效。");
  const protocol = input.protocol;
  if (protocol !== "openai-chat-completions" && protocol !== "anthropic-messages") throw new Error("尚未支持此接入协议。");
  const url = new URL(text("baseUrl", 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("接口地址必须是无用户名、密码或查询参数的 HTTPS 地址。");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) throw new Error("请填写公开模型服务的域名地址。");
  if (!Array.isArray(input.capabilities) || !input.capabilities.length
    || input.capabilities.some((item) => !["text", "image", "audio"].includes(String(item)))) {
    throw new Error("请选择模型实际支持的输入能力。");
  }
  const capabilities = [...new Set(input.capabilities)] as ModelUnderstandingCapability[];
  if (protocol === "anthropic-messages" && capabilities.includes("audio")) {
    throw new Error("当前 Anthropic Messages 适配器不支持直接音频输入，不能将转写标为审听。");
  }
  const maxOutputTokens = input.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || Number(maxOutputTokens) < 1 || Number(maxOutputTokens) > 262144) {
    throw new Error("请根据模型文档填写最大输出 token 数（1–262144）。");
  }
  const reasoningEffort = input.reasoningEffort;
  if (reasoningEffort !== undefined && (protocol !== "openai-chat-completions"
    || !["low", "medium", "high", "xhigh", "max"].includes(String(reasoningEffort)))) {
    throw new Error("此协议的推理强度配置无效。");
  }
  const thinkingBudget = input.thinkingBudget;
  if (thinkingBudget !== undefined && (protocol !== "anthropic-messages" || !Number.isInteger(thinkingBudget)
    || Number(thinkingBudget) < 1024 || Number(thinkingBudget) >= Number(maxOutputTokens))) {
    throw new Error("Anthropic thinking budget 至少为 1024，且必须小于最大输出 token 数。");
  }
  return {
    label, protocol, baseUrl: url.toString().replace(/\/$/, ""), modelId, apiKey, capabilities,
    maxOutputTokens: Number(maxOutputTokens),
    ...(reasoningEffort ? { reasoningEffort: reasoningEffort as NonNullable<ModelConnectionInput["reasoningEffort"]> } : {}),
    ...(thinkingBudget !== undefined ? { thinkingBudget: Number(thinkingBudget) } : {}),
  };
}
