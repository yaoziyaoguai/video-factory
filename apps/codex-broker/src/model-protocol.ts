import type { ModelConnectionInput } from "@video-factory/production-pipeline/model-connection";

export function configuredModelRequest(config: ModelConnectionInput, prompt: string, images: Buffer[], audio?: Buffer) {
  const base = config.baseUrl.replace(/\/$/, "");
  if (images.length && !config.capabilities.includes("image")) throw new Error("所选模型未声明图像理解能力。");
  if (audio && (config.protocol !== "openai-chat-completions" || !config.capabilities.includes("audio"))) throw new Error("所选模型接入不支持真实音频输入。");
  if (config.protocol === "anthropic-messages") {
    return {
      endpoint: `${base}/messages`,
      headers: { "content-type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
      body: {
        model: config.modelId,
        max_tokens: config.maxOutputTokens,
        ...(config.thinkingBudget ? { thinking: { type: "enabled", budget_tokens: config.thinkingBudget } } : {}),
        messages: [{ role: "user", content: [
          { type: "text", text: prompt },
          ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.toString("base64") } })),
        ] }],
        // 非流式协议同样有整体截止时间；不会伪造首 token 耗时。
        stream: false,
      },
    };
  }
  return {
    endpoint: `${base}/chat/completions`,
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: {
      model: config.modelId,
      messages: [{ role: "user", content: images.length || audio ? [
        { type: "text", text: prompt },
        ...images.map((image) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } })),
        ...(audio ? [{ type: "input_audio", input_audio: { data: audio.toString("base64"), format: "mp3" } }] : []),
      ] : prompt }],
      max_tokens: config.maxOutputTokens,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      stream: true,
    },
  };
}

/** 只转换传输信封；业务 JSON、合同校验和有界格式修复仍共用原执行器。 */
export function anthropicCompletionEnvelope(raw: string): string {
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value.type !== "message" || !Array.isArray(value.content) || typeof value.stop_reason !== "string") {
    throw new Error("Anthropic Messages 返回了无效的响应信封。");
  }
  const text = value.content.filter((part) => part && part.type === "text").map((part) => part.text).join("");
  if (typeof text !== "string" || !text.trim()) throw new Error("Anthropic Messages 未返回文本结果。");
  const usage = value.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  return JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: value.stop_reason === "max_tokens" ? "length" : value.stop_reason === "end_turn" || value.stop_reason === "stop_sequence" ? "stop" : value.stop_reason }],
    ...(usage ? { usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens } } : {}),
  });
}
