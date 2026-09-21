import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CodexBrokerServer } from "../../codex-broker/src/broker-server.js";
import { ModelRegistry } from "../../codex-broker/src/model-registry.js";
import { codexExecutorProfileFor } from "../../codex-broker/src/codex-executor.js";
import { ModelConnections } from "../src/server/model-connections.js";
import { includeRegisteredModels } from "../src/server/registered-model-catalog.js";
import { buildRoleAgentAssembly } from "../src/server/role-agent-assembly.js";

test("Studio management reaches the broker registry and refreshes the real selectable role catalog", async () => {
  const directory = await mkdtemp("/tmp/vf-model-api-");
  const identity = codexExecutorProfileFor("deepseek").identity;
  let executions = 0;
  const executor = { identity, runTask: async () => { executions++; throw new Error("saving must not call a model"); } };
  const registry = new ModelRegistry({ directory, socketDirectory: directory, timeoutMs: 1000, createExecutor: () => executor });
  const socket = path.join(directory, "root.sock");
  const server = new CodexBrokerServer({ socketPath: socket, executor, modelManagement: (method, url, body) => registry.handle(method, url, body) });
  try {
    await registry.start(); await server.start();
    const manager = new ModelConnections(socket);
    let changes = 0;
    manager.onChange = () => { changes++; };
    assert.deepEqual(await manager.refresh(), []);
    const models = await manager.add({ label: "独立模型", protocol: "anthropic-messages", modelId: "vendor/model", baseUrl: "https://example.com/v1", apiKey: "private-test", capabilities: ["text", "image"], maxOutputTokens: 32000 });
    assert.equal(models.length, 1);
    assert.ok(!JSON.stringify(models).includes("private-test"));
    const id = models[0]!.id;
    const client = manager.connections[0]!.client;
    const catalog = includeRegisteredModels([{ id: "codex-screenwriter-v1", label: "编剧", capability: "script.draft", kind: "external", available: false, billing: "subscription", latency: "seconds", modes: [], description: "" }], models, { python: true, ffmpeg: true, ffprobe: true });
    assert.equal(catalog[0]!.available, true);
    assert.equal(catalog[0]!.modelProfiles?.[0]?.id, id);
    const assembly = buildRoleAgentAssembly({ connectedModels: manager.connections, environment: {}, deepseekCodexSettings: { available: false, reason: "测试无默认", socketPath: socket, modelId: "unused", taskKinds: [] }, reviewMedia: { prepare: async () => { throw new Error("unused"); } } });
    assert.equal(assembly.screenwriterAgent?.modelId, id);
    assert.equal(assembly.directorAgent?.modelId, id);
    assert.equal(assembly.visualReviewAgents.length, 1);
    await manager.disable(id);
    assert.equal(manager.connections[0]!.model.enabled, false);
    assert.equal(manager.connections[0]!.client, client, "keep original client for accepted task recovery");
    await manager.enable(id);
    assert.equal(manager.connections[0]!.model.enabled, true);
    assert.equal(changes, 4);
    assert.equal(executions, 0);
  } finally { await server.close(); await registry.close(); await rm(directory, { recursive: true, force: true }); }
});
