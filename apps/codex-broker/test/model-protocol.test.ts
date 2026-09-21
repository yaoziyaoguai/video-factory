import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredModelRequest, anthropicCompletionEnvelope } from "../src/model-protocol.js";
import type { ModelConnectionInput } from "@video-factory/production-pipeline";

const config: ModelConnectionInput = {
  label: "独立接入", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "org/model",
  apiKey: "test-secret", capabilities: ["text", "image"], maxOutputTokens: 32000,
};
test("OpenAI-compatible models share transport without inheriting DeepSeek-specific options", () => {
  const request = configuredModelRequest(config, "审查画面", [Buffer.from("image")]);
  assert.equal(request.endpoint, "https://example.com/v1/chat/completions");
  assert.equal(request.body.model, "org/model");
  assert.equal(request.body.max_tokens, 32000);
  assert.equal("thinking" in request.body, false);
  assert.equal("reasoning_effort" in request.body, false);
  assert.throws(() => configuredModelRequest({ ...config, capabilities: ["text"] }, "看图", [Buffer.from("image")]), /图像/);
});
test("Anthropic uses its own authentication, image blocks and thinking budget", () => {
  const request = configuredModelRequest({ ...config, protocol: "anthropic-messages", thinkingBudget: 8000 }, "审查", [Buffer.from("image")]);
  assert.equal(request.endpoint, "https://example.com/v1/messages");
  assert.equal(request.headers["x-api-key"], "test-secret");
  assert.equal("authorization" in request.headers, false);
  assert.deepEqual("thinking" in request.body ? request.body.thinking : undefined, { type: "enabled", budget_tokens: 8000 });
  assert.match(JSON.stringify(request.body), /media_type/);
});
test("Anthropic response keeps truncation and usage visible and excludes thinking from business output", () => {
  const envelope = JSON.parse(anthropicCompletionEnvelope(JSON.stringify({
    type: "message", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: '{"result":true}' }],
    stop_reason: "max_tokens", usage: { input_tokens: 12, output_tokens: 25 },
  })));
  assert.equal(envelope.choices[0].message.content, '{"result":true}');
  assert.equal(envelope.choices[0].finish_reason, "length");
  assert.equal(envelope.usage.prompt_tokens, 12);
});
