import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelConnectionInput } from "../src/model-connection.js";

const input = {
  label: "我的模型", protocol: "openai-chat-completions", baseUrl: "https://models.example/v1/",
  modelId: "org/model", apiKey: "test-only-key", capabilities: ["text", "image", "audio"], maxOutputTokens: 32768,
};

test("keeps protocol, upstream model and overlapping capabilities separate", () => {
  const parsed = parseModelConnectionInput(input);
  assert.equal(parsed.baseUrl, "https://models.example/v1");
  assert.equal(parsed.modelId, "org/model");
  assert.deepEqual(parsed.capabilities, ["text", "image", "audio"]);
  assert.equal(parsed.reasoningEffort, undefined);
});

test("does not label an unsupported audio protocol as listening", () => {
  assert.throws(() => parseModelConnectionInput({ ...input, protocol: "anthropic-messages" }), /直接音频/);
  assert.throws(() => parseModelConnectionInput({ ...input, baseUrl: "https://user:secret@models.example/v1" }), /HTTPS/);
  assert.throws(() => parseModelConnectionInput({ ...input, maxOutputTokens: undefined }), /最大输出/);
  assert.throws(() => parseModelConnectionInput({ ...input, apiKey: "secret\nheader" }), /apiKey/);
});

test("validates protocol-specific thinking parameters instead of silently ignoring them", () => {
  assert.throws(() => parseModelConnectionInput({ ...input, thinkingBudget: 2048 }), /thinking budget/);
  assert.throws(() => parseModelConnectionInput({ ...input, protocol: "anthropic-messages", capabilities: ["text"], reasoningEffort: "max" }), /推理强度/);
  assert.equal(parseModelConnectionInput({ ...input, protocol: "anthropic-messages", capabilities: ["text"], thinkingBudget: 2048 }).thinkingBudget, 2048);
});
