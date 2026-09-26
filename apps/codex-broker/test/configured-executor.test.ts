import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ChatCompletionsExecutor, DEEPSEEK_CHAT_COMPLETIONS_PROVIDER } from "../src/chat-completions-executor.js";
import { parseTaskRequest } from "../src/codex-executor.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";
import { AUDIO_REVIEW_CHECKS } from "@video-factory/production-pipeline/audio-review";

for (const protocol of ["openai-chat-completions", "anthropic-messages"] as const) {
  test(`configured ${protocol} uses the upstream model and protocol but keeps durable connection identity`, async () => {
    let calls = 0;
    const executor = new ChatCompletionsExecutor({
      provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER,
      configuredModel: { id: "m-111111111111", connection: { label: "测试接入", protocol, baseUrl: "https://example.com/v1", modelId: "native/model", apiKey: "test-secret", capabilities: ["text"], maxOutputTokens: 32000 } },
      env: {}, fetchFn: async (url, init) => {
        calls++;
        assert.equal(String(url), `https://example.com/v1/${protocol === "anthropic-messages" ? "messages" : "chat/completions"}`);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, "native/model");
        assert.equal(body.max_tokens, 32000);
        assert.equal(body.thinking, undefined);
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(protocol === "anthropic-messages" ? headers.get("x-api-key") : headers.get("authorization"), protocol === "anthropic-messages" ? "test-secret" : "Bearer test-secret");
        return new Response(JSON.stringify(protocol === "anthropic-messages"
          ? { type: "message", content: [{ type: "text", text: '{"ideas":[]}' }], stop_reason: "end_turn" }
          : { choices: [{ message: { content: '{"ideas":[]}' }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
      },
    });
    const task = parseTaskRequest({ kind: "topic-ideas", protocolVersion: "video-factory/codex-bridge-v2", expectedContractDigest: taskContractDescriptorFor("topic-ideas").digest, payload: { signals: [{ id: "one", title: "测试", platform: "douyin", rank: 1 }] } }, executor.identity);
    const result = await executor.runTask(task, { model: "m-111111111111" });
    assert.equal(calls, 1);
    assert.deepEqual(JSON.parse(result.output), { ideas: [] });
    assert.equal(result.trace?.providerId, "m-111111111111");
    assert.equal(result.trace?.modelId, "m-111111111111");
    assert.ok(!JSON.stringify(result).includes("test-secret"));
  });
}

for (const baseUrl of ["https://example.com/v1", "https://dashscope.aliyuncs.com/api/v1/workspaces/ws-test/compatible-mode/v1"]) {
test(`configured audio executor sends actual MP3 bytes and timecoded frames using ${new URL(baseUrl).hostname}`, async () => {
  const audio = Buffer.from("ID3-test-audio");
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const executor = new ChatCompletionsExecutor({
    provider: DEEPSEEK_CHAT_COMPLETIONS_PROVIDER, env: {},
    configuredModel: { id: "m-222222222222", connection: { label: "声音", protocol: "openai-chat-completions", baseUrl, modelId: "native-audio", apiKey: "test", capabilities: ["audio", "image"], maxOutputTokens: 32000 } },
    fetchFn: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "native-audio");
      const parts = body.messages[0].content;
      const encoded = parts.find((item: { type: string }) => item.type === "input_audio").input_audio.data;
      if (new URL(baseUrl).hostname === "dashscope.aliyuncs.com") assert.equal(encoded, `data:;base64,${audio.toString("base64")}`);
      else assert.equal(encoded, audio.toString("base64"));
      assert.deepEqual(body.modalities, ["text"]);
      assert.ok(parts.some((item: { type: string }) => item.type === "image_url"));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ audioSha256: sha(audio), summary: "证据传输测试", checks: Object.fromEntries(AUDIO_REVIEW_CHECKS.map((key) => [key, "not_observed"])), findings: [] }) }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } });
    },
  });
  const task = parseTaskRequest({ protocolVersion: "video-factory/codex-bridge-v2", kind: "audio-review", expectedContractDigest: taskContractDescriptorFor("audio-review").digest, payload: {
    durationMs: 1000, audioSha256: sha(audio), audioBase64: audio.toString("base64"), frames: [{ timecodeMs: 0, sha256: sha(image), jpegBase64: image.toString("base64") }],
  } }, executor.identity);
  const result = await executor.runTask(task);
  assert.equal(result.trace?.modelAttemptCount, 1);
  assert.equal(JSON.parse(result.output).audioSha256, sha(audio));
});
}
