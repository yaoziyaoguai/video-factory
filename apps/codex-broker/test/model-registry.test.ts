import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ModelRegistry } from "../src/model-registry.js";
import { CodexBridgeClient, type CodexPreparedOperation } from "../../../packages/production-pipeline/src/codex-chat.js";
import { taskContractDescriptorFor } from "../src/task-definitions.js";

test("registry persists private credentials, uses separate durable model identities, and resumes after disable/restart", async () => {
  const directory = await mkdtemp("/tmp/vf-registry-");
  let calls = 0;
  const make = () => new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 2000,
    createExecutor: (entry) => ({
      identity: { profileId: "deepseek", providerId: entry.id, modelId: entry.id, taskKinds: ["topic-ideas"] },
      modelCandidates: [entry.id],
      runTask: async (task) => {
        calls++;
        return { output: '{"ideas":[]}', trace: {
          providerId: entry.id, modelId: entry.id, taskKind: task.kind,
          promptVersion: taskContractDescriptorFor(task.kind).promptVersion,
          contractDigest: taskContractDescriptorFor(task.kind).digest, prompt: "test",
        } };
      },
    }),
  });
  let registry = make();
  try {
    await registry.start();
    const input = { label: "我的模型", protocol: "openai-chat-completions", baseUrl: "https://example.com/v1", modelId: "native/model", apiKey: "private-test-key", capabilities: ["text"], maxOutputTokens: 32768 };
    await registry.handle("POST", "/v1/models", input);
    await registry.handle("POST", "/v1/models", input);
    const models = registry.list();
    assert.equal(models.length, 2);
    assert.notEqual(models[0]!.id, models[1]!.id);
    assert.ok(!JSON.stringify(await registry.handle("GET", "/v1/models")).includes("private-test-key"));
    assert.equal((await stat(path.join(directory, "models.json"))).mode & 0o777, 0o600);
    assert.match(await readFile(path.join(directory, "models.json"), "utf8"), /private-test-key/);
    const model = models[0]!;
    const client = new CodexBridgeClient({ socketPath: path.join(directory, model.socketName), timeoutMs: 5000 });
    let prepared: CodexPreparedOperation | undefined;
    const result = await client.runTaskDetailed("topic-ideas", { signals: [{ id: "one", platform: "douyin", rank: 1, title: "topic" }] }, "registry-test", undefined, {
      model: model.id, beforeSubmit: async (operation) => { prepared = operation; },
    });
    assert.deepEqual(result.output, { ideas: [] });
    assert.equal(result.trace?.modelId, model.id);
    await registry.handle("POST", `/v1/models/${model.id}/disable`);
    await registry.close();
    registry = make(); await registry.start();
    assert.equal(registry.list()[0]!.enabled, false);
    const recovered = await client.observePrepared(prepared!);
    assert.deepEqual(recovered.output, { ideas: [] });
    assert.equal(calls, 1);
    await assert.rejects(() => client.runTask("topic-ideas", { signals: [{ id: "two", platform: "douyin", rank: 1, title: "new" }] }, "disabled-task"));
    assert.equal(calls, 1);
    await registry.handle("POST", `/v1/models/${model.id}/enable`);
    assert.equal(registry.list()[0]!.enabled, true);
  } finally { await registry.close(); await rm(directory, { recursive: true, force: true }); }
});
